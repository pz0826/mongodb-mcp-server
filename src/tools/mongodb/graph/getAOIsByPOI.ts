import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DbOperationArgs, MongoDBToolBase } from "../mongodbTool.js";
import type { ToolArgs, OperationType, ToolExecutionContext } from "../../tool.js";
import { formatUntrustedData } from "../../tool.js";
import { LogId } from "../../../common/logger.js";

export const GetAOIsByPOIArgs = {
    database: z.string().describe("数据库名称"),
    poiName: z.string().describe("POI名称（支持模糊匹配）"),
    exactMatch: z
        .boolean()
        .optional()
        .default(false)
        .describe("是否精确匹配POI名称（默认false，使用模糊匹配）"),
    poiCollection: z
        .string()
        .optional()
        .default("pois")
        .describe("POI所在的集合名称（默认为'pois'）"),
    aoiCollection: z
        .string()
        .optional()
        .default("aois")
        .describe("AOI所在的集合名称（默认为'aois'）"),
};

/**
 * 根据POI名称获取包含它的AOI工具
 */
export class GetAOIsByPOITool extends MongoDBToolBase {
    public name = "get_aois_by_poi";
    protected description =
        "根据POI（兴趣点）名称查询包含该兴趣点的所有AOI（兴趣区域）。返回AOI的详细信息，包括AOI ID、名称、类型等。可用于后续查询该AOI连接的道路。";
    protected argsShape = GetAOIsByPOIArgs;
    public operationType: OperationType = "read";

    /**
     * 将MongoDB Long类型转换为Number
     */
    private convertLongToNumber(value: any): number {
        if (value && typeof value === 'object' && 'low' in value && 'high' in value) {
            return value.high * 4294967296 + (value.low >>> 0);
        }
        return Number(value);
    }

    protected async execute(
        { database, poiName, exactMatch, poiCollection, aoiCollection }: ToolArgs<typeof this.argsShape>,
        { signal }: ToolExecutionContext
    ): Promise<CallToolResult> {
        try {
            const provider = await this.ensureConnected();

            this.session.logger.info({
                id: LogId.graphQueryStart,
                context: "getAOIsByPOI",
                message: `查询POI "${poiName}" 包含在哪些AOI中（POI集合: ${poiCollection}, AOI集合: ${aoiCollection}）`,
            });

            // 步骤1: 从 pois 集合查询匹配的POI
            const poiQuery = exactMatch
                ? { "name": poiName }
                : { "name": { $regex: poiName, $options: "i" } };

            const pois = await provider
                .aggregate(database, poiCollection, [
                    { $match: poiQuery },
                    {
                        $project: {
                            _id: 0,
                            id: 1,
                            name: 1,
                            catg: 1,
                            geometry: 1,
                        },
                    },
                ])
                .toArray();

            if (pois.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `未找到匹配的POI: "${poiName}"`,
                        },
                    ],
                    isError: true,
                };
            }

            // 转换POI ID
            const poiIds = pois.map((poi: any) => this.convertLongToNumber(poi.id));

            this.session.logger.info({
                id: LogId.graphQueryStart,
                context: "getAOIsByPOI",
                message: `找到 ${pois.length} 个匹配的POI，ID: ${poiIds.join(", ")}`,
            });

            // 步骤2: 从 aois 集合查询包含这些POI的AOI
            const aois = await provider
                .aggregate(database, aoiCollection, [
                    {
                        $match: {
                            "include_poi": { $in: poiIds },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            id: 1,
                            name: 1,
                            catg: 1,
                            include_poi: 1,
                            include_aoi: 1,
                        },
                    },
                ])
                .toArray();

            if (aois.length === 0) {
                return {
                    content: formatUntrustedData(
                        `找到 ${pois.length} 个匹配的POI，但它们未被任何AOI包含`,
                        JSON.stringify(
                            {
                                matchedPOIs: pois.map((poi: any) => ({
                                    id: this.convertLongToNumber(poi.id),
                                    name: poi.name,
                                    category: poi.catg,
                                    coordinates: poi.geometry?.coordinates,
                                })),
                            },
                            null,
                            2
                        )
                    ),
                };
            }

            // 格式化结果
            const result = {
                matchedPOIs: pois.map((poi: any) => ({
                    id: this.convertLongToNumber(poi.id),
                    name: poi.name,
                    category: poi.catg,
                    coordinates: poi.geometry?.coordinates,
                })),
                containingAOIs: aois.map((aoi: any) => ({
                    aoiId: this.convertLongToNumber(aoi.id),
                    name: aoi.name,
                    category: aoi.catg,
                    // 节约token
                    // includedPOIs: (aoi.include_poi || []).map((id: any) =>
                    //     this.convertLongToNumber(id)
                    // ),
                    // includedAOIs: (aoi.include_aoi || []).map((id: any) =>
                    //     this.convertLongToNumber(id)
                    // ),
                })),
                summary: {
                    totalPOIs: pois.length,
                    totalAOIs: aois.length,
                },
            };

            this.session.logger.info({
                id: LogId.graphQueryComplete,
                context: "getAOIsByPOI",
                message: `查询完成: ${pois.length} 个POI, ${aois.length} 个包含AOI`,
            });

            return {
                content: formatUntrustedData(
                    `查询POI "${poiName}" 被哪些AOI包含`,
                    JSON.stringify(result, null, 2)
                ),
            };
        } catch (error) {
            this.session.logger.error({
                id: LogId.graphQueryError,
                context: "getAOIsByPOI",
                message: `查询失败: ${error}`,
            });
            return this.handleError(error, arguments[0]);
        }
    }
}

