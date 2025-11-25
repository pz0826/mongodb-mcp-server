import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DbOperationArgs, MongoDBToolBase } from "../mongodbTool.js";
import type { ToolArgs, OperationType, ToolExecutionContext } from "../../tool.js";
import { formatUntrustedData } from "../../tool.js";
import { LogId } from "../../../common/logger.js";

export const GetRoadsByAOIArgs = {
    database: z.string().describe("数据库名称"),
    aoiName: z.string().describe("AOI名称（支持模糊匹配）"),
    exactMatch: z
        .boolean()
        .optional()
        .default(false)
        .describe("是否精确匹配AOI名称（默认false，使用模糊匹配）"),
    aoiCollection: z
        .string()
        .optional()
        .default("aois")
        .describe("AOI所在的集合名称（默认为'aois'）"),
    roadCollection: z
        .string()
        .optional()
        .default("roadnet")
        .describe("道路所在的集合名称（默认为'roadnet'）"),
};

/**
 * 根据AOI名称获取连接的道路工具
 */
export class GetRoadsByAOITool extends MongoDBToolBase {
    public name = "get_roads_by_aoi";
    protected description =
        "根据AOI（兴趣区域）名称查询连接到该区域的所有道路。返回道路的详细信息，包括道路ID、名称、类型、长度、通行时间等。可用于后续的路径规划查询。";
    protected argsShape = GetRoadsByAOIArgs;
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
        { database, aoiName, exactMatch, aoiCollection, roadCollection }: ToolArgs<typeof this.argsShape>,
        { signal }: ToolExecutionContext
    ): Promise<CallToolResult> {
        try {
            const provider = await this.ensureConnected();

            this.session.logger.info({
                id: LogId.graphQueryStart,
                context: "getRoadsByAOI",
                message: `查询AOI "${aoiName}" 连接的道路（AOI集合: ${aoiCollection}, 道路集合: ${roadCollection}）`,
            });

            // 步骤1: 从 aois 集合查询匹配的AOI
            const aoiQuery = exactMatch
                ? { "name": aoiName }
                : { "name": { $regex: aoiName, $options: "i" } };

            const aois = await provider
                .aggregate(database, aoiCollection, [
                    { $match: aoiQuery },
                    {
                        $project: {
                            _id: 0,
                            id: 1,
                            name: 1,
                            catg: 1,
                        },
                    },
                ])
                .toArray();

            if (aois.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `未找到匹配的AOI: "${aoiName}"`,
                        },
                    ],
                    isError: true,
                };
            }

            // 转换AOI ID
            const aoiIds = aois.map((aoi: any) => this.convertLongToNumber(aoi.id));

            this.session.logger.info({
                id: LogId.graphQueryStart,
                context: "getRoadsByAOI",
                message: `找到 ${aois.length} 个匹配的AOI，ID: ${aoiIds.join(", ")}`,
            });

            // 步骤2: 从 roadnet 集合查询连接这些AOI的道路
            const roads = await provider
                .aggregate(database, roadCollection, [
                    {
                        $match: {
                            "connect_aoi": { $in: aoiIds },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            id: 1,
                            name: 1,
                            catg: 1,
                            length: 1,
                            cost: 1,
                            max_speed: 1,
                            from_junction: 1,
                            to_junction: 1,
                            connect_aoi: 1,
                            gate: 1,
                        },
                    },
                ])
                .toArray();

            if (roads.length === 0) {
                return {
                    content: formatUntrustedData(
                        `找到 ${aois.length} 个匹配的AOI，但没有连接的道路`,
                        JSON.stringify(
                            {
                                matchedAOIs: aois.map((aoi: any) => ({
                                    id: this.convertLongToNumber(aoi.id),
                                    name: aoi.name,
                                    category: aoi.catg,
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
                matchedAOIs: aois.map((aoi: any) => ({
                    id: this.convertLongToNumber(aoi.id),
                    name: aoi.name,
                    category: aoi.catg,
                })),
                connectedRoads: roads.map((road: any) => {
                    const roadId = this.convertLongToNumber(road.id);
                    // 找到该道路连接到查询AOI的gate信息
                    const relevantGates = (road.gate || []).filter((g: any) =>
                        aoiIds.includes(this.convertLongToNumber(g.aoi_id))
                    );

                    return {
                        roadId: roadId,
                        name: road.name || "未命名道路",
                        category: road.catg,
                        // 节省token
                        // length: `${Number(road.length).toFixed(2)} 米`,
                        // cost: `${Number(road.cost).toFixed(2)} 秒`,
                        // maxSpeed: road.max_speed
                        //     ? `${(Number(road.max_speed) * 3.6).toFixed(1)} km/h`
                        //     : "未知",
                        fromJunction: this.convertLongToNumber(road.from_junction),
                        toJunction: this.convertLongToNumber(road.to_junction),
                        // 节省token
                        // connectedAOIs: (road.connect_aoi || []).map((id: any) =>
                        //     this.convertLongToNumber(id)
                        // ),
                        gates: relevantGates.map((g: any) => ({
                            aoiId: this.convertLongToNumber(g.aoi_id),
                            type: g.type,
                            coordinates: g.coordinates,
                        })),
                    };
                }),
                summary: {
                    totalAOIs: aois.length,
                    totalRoads: roads.length,
                },
            };

            this.session.logger.info({
                id: LogId.graphQueryComplete,
                context: "getRoadsByAOI",
                message: `查询完成: ${aois.length} 个AOI, ${roads.length} 条连接道路`,
            });

            return {
                content: formatUntrustedData(
                    `查询AOI "${aoiName}" 连接的道路`,
                    JSON.stringify(result, null, 2)
                ),
            };
        } catch (error) {
            this.session.logger.error({
                id: LogId.graphQueryError,
                context: "getRoadsByAOI",
                message: `查询失败: ${error}`,
            });
            return this.handleError(error, arguments[0]);
        }
    }
}

