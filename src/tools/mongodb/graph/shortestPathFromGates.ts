import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DbOperationArgs, MongoDBToolBase } from "../mongodbTool.js";
import type { ToolArgs, OperationType, ToolExecutionContext } from "../../tool.js";
import { formatUntrustedData } from "../../tool.js";
import { LogId } from "../../../common/logger.js";

/**
 * 优先队列节点
 */
interface PriorityQueueNode {
    junctionId: number;
    cost: number;
}

/**
 * 优先队列实现（最小堆）
 */
class PriorityQueue {
    private heap: PriorityQueueNode[] = [];

    push(node: PriorityQueueNode): void {
        this.heap.push(node);
        this.bubbleUp(this.heap.length - 1);
    }

    pop(): PriorityQueueNode | undefined {
        if (this.heap.length === 0) return undefined;
        if (this.heap.length === 1) return this.heap.pop();

        const top = this.heap[0];
        this.heap[0] = this.heap.pop()!;
        this.bubbleDown(0);
        return top;
    }

    isEmpty(): boolean {
        return this.heap.length === 0;
    }

    private bubbleUp(index: number): void {
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            const parent = this.heap[parentIndex];
            const current = this.heap[index];
            if (!parent || !current || parent.cost <= current.cost) break;

            [this.heap[parentIndex], this.heap[index]] = [current, parent];
            index = parentIndex;
        }
    }

    private bubbleDown(index: number): void {
        while (true) {
            let minIndex = index;
            const leftChild = 2 * index + 1;
            const rightChild = 2 * index + 2;

            const minNode = this.heap[minIndex];
            const leftNode = this.heap[leftChild];
            const rightNode = this.heap[rightChild];

            if (leftChild < this.heap.length && leftNode && minNode && leftNode.cost < minNode.cost) {
                minIndex = leftChild;
            }
            if (
                rightChild < this.heap.length &&
                rightNode &&
                this.heap[minIndex] &&
                rightNode.cost < this.heap[minIndex]!.cost
            ) {
                minIndex = rightChild;
            }

            if (minIndex === index) break;

            const temp = this.heap[minIndex];
            const indexNode = this.heap[index];
            if (!temp || !indexNode) break;
            [this.heap[minIndex], this.heap[index]] = [indexNode, temp];
            index = minIndex;
        }
    }
}

/**
 * 道路数据结构
 */
interface RoadEdge {
    id: number;
    from_junction: number;
    to_junction: number;
    length: number;
    cost: number;
    name?: string;
    catg?: string;
    max_speed?: number;
}

/**
 * Gate信息
 */
interface Gate {
    aoi_id: number;
    type: string;
    coordinates: number[];
}

/**
 * 最短路径结果
 */
interface ShortestPathResult {
    found: boolean;
    path?: number[];
    roads?: RoadEdge[];
    totalDistance?: number;
    totalCost?: number;
    statistics?: {
        visitedJunctions: number;
        totalJunctions: number;
        totalRoads: number;
        computationTimeMs: number;
    };
}

export const ShortestPathFromGatesArgs = {
    startRoadId: z.number().describe("起点道路ID"),
    endRoadId: z.number().describe("终点道路ID"),
    startAOIId: z.number().describe("起点AOI ID"),
    endAOIId: z.number().describe("终点AOI ID"),
    travelMode: z
        .enum(["driving", "walking"])
        .describe("通行类型：'driving'表示驾车（排除人行道、自行车道、台阶），'walking'表示步行（包含所有道路）"),
    weightField: z
        .enum(["cost", "length"])
        .optional()
        .default("cost")
        .describe("权重字段：'cost'表示按时间最短，'length'表示按距离最短"),
    includeRoadDetails: z
        .boolean()
        .optional()
        .default(true)
        .describe("是否在结果中包含完整的道路详细信息"),
};

/**
 * 从AOI gate出入口计算最短路径工具（使用Dijkstra算法）
 */
export class ShortestPathFromGatesTool extends MongoDBToolBase {
    public name = "shortest_path_from_gates";
    protected description = `计算从起点AOI的gate到终点AOI的gate之间的最短路径。

**使用步骤**：
1. 在查询起点和终点前，需要先使用find工具判断查询对象是POI还是AOI，然后根据查询对象选择合适的工具，若POI，AOI均有，则优先选择AOI。
2. 对于POI查询，先使用 get_aois_by_poi 工具根据POI名称获取包含该POI的AOI ID，然后选择合适（最为具体，而非代表一大片区域的）AOI名称或ID，跳转到AOI查询步骤
3. 对于AOI查询，使用 get_roads_by_aoi 工具根据AOI名称或ID获取连接到该AOI的道路ID列表，然后跳转到道路查询步骤
4. 从返回的道路列表中选择合适的起点道路和终点道路，调用本函数进行查询

**注意**：所有POI在构建数据时都已绑定到至少一个AOI，因此即使查询对象是POI，也需要输入其对应的AOI作为参数。`;

    protected argsShape = {
        ...DbOperationArgs,
        ...ShortestPathFromGatesArgs,
    };
    public operationType: OperationType = "read";

    // 新junction ID的起始编号
    private static readonly GATE_JUNCTION_ID_START = 60000000001;
    private gateJunctionCounter = 0;
    
    // 步行速度常量（米/秒）
    private static readonly WALKING_SPEED = 1.4;

    /**
     * 将MongoDB Long类型转换为Number
     */
    private convertLongToNumber(value: any): number {
        if (value && typeof value === "object" && "low" in value && "high" in value) {
            return value.high * 4294967296 + (value.low >>> 0);
        }
        return Number(value);
    }

    /**
     * 计算两点之间的距离（米）
     */
    private calculateDistance(coord1: number[], coord2: number[]): number {
        const R = 6371000; // 地球半径（米）
        const lat1 = ((coord1[1] ?? 0) * Math.PI) / 180;
        const lat2 = ((coord2[1] ?? 0) * Math.PI) / 180;
        const deltaLat = (((coord2[1] ?? 0) - (coord1[1] ?? 0)) * Math.PI) / 180;
        const deltaLon = (((coord2[0] ?? 0) - (coord1[0] ?? 0)) * Math.PI) / 180;

        const a =
            Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    }

    /**
     * 检查gate坐标是否在道路端点上
     */
    private isGateAtEndpoint(gateCoord: number[], roadCoords: number[][], tolerance: number = 0.00001): boolean {
        if (roadCoords.length === 0) return false;
        
        const firstPoint = roadCoords[0] ?? [];
        const lastPoint = roadCoords[roadCoords.length - 1] ?? [];

        const distToFirst = this.calculateDistance(gateCoord, firstPoint);
        const distToLast = this.calculateDistance(gateCoord, lastPoint);

        return distToFirst < tolerance || distToLast < tolerance;
    }

    /**
     * 根据出行模式计算道路的 cost（秒）
     */
    private calculateRoadCost(length: number, maxSpeed: number, travelMode: "driving" | "walking"): number {
        if (travelMode === "walking") {
            return length / ShortestPathFromGatesTool.WALKING_SPEED;
        } else {
            // 驾车模式：使用道路限速计算（max_speed 单位是 m/s）
            return maxSpeed > 0 ? length / maxSpeed : length / 8.33; // 默认 30 km/h ≈ 8.33 m/s
        }
    }

    protected async execute(
        {
            database,
            collection,
            startRoadId,
            endRoadId,
            startAOIId,
            endAOIId,
            travelMode,
            weightField,
            includeRoadDetails,
        }: ToolArgs<typeof this.argsShape>,
        { signal }: ToolExecutionContext
    ): Promise<CallToolResult> {
        const startTime = Date.now();
        this.gateJunctionCounter = 0;

        try {
            const provider = await this.ensureConnected();

            this.session.logger.info({
                id: LogId.shortestPathStart,
                context: "shortestPathFromGates",
                message: `计算从道路 ${startRoadId} (AOI ${startAOIId}) 到道路 ${endRoadId} (AOI ${endAOIId}) 的最短路径，通行类型: ${travelMode}`,
            });

            // 验证起点和终点道路
            const inputRoads = await provider
                .aggregate(database, collection, [
                    {
                        $match: {
                            id: { $in: [startRoadId, endRoadId] },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            id: 1,
                            from_junction: 1,
                            to_junction: 1,
                            length: 1,
                            name: 1,
                            catg: 1,
                            max_speed: 1,
                            connect_aoi: 1,
                            gate: 1,
                            geometry: 1,
                        },
                    },
                ])
                .toArray();

            if (inputRoads.length !== 2) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `错误：未找到起点道路 ${startRoadId} 或终点道路 ${endRoadId}`,
                        },
                    ],
                    isError: true,
                };
            }

            // 验证道路是否连接到指定的AOI
            const startRoad = inputRoads.find((r: any) => this.convertLongToNumber(r.id) === startRoadId);
            const endRoad = inputRoads.find((r: any) => this.convertLongToNumber(r.id) === endRoadId);

            if (!startRoad || !endRoad) {
                return {
                    content: [{ type: "text", text: "错误：无法找到对应的道路数据" }],
                    isError: true,
                };
            }

            // 验证connect_aoi字段
            const startConnectAOIs = (startRoad?.connect_aoi || []).map((id: any) => this.convertLongToNumber(id));
            const endConnectAOIs = (endRoad?.connect_aoi || []).map((id: any) => this.convertLongToNumber(id));

            if (!startConnectAOIs.includes(startAOIId)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `错误：起点道路 ${startRoadId} 未连接到AOI ${startAOIId}`,
                        },
                    ],
                    isError: true,
                };
            }

            if (!endConnectAOIs.includes(endAOIId)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `错误：终点道路 ${endRoadId} 未连接到AOI ${endAOIId}`,
                        },
                    ],
                    isError: true,
                };
            }

            // 验证gate的type字段
            const startGates = (startRoad?.gate || []) as Gate[];
            const endGates = (endRoad?.gate || []) as Gate[];

            // 优先查找与travelMode匹配的gate
            // 如果是walking模式，driving类型的gate也可以使用（能开车的地方一定能走路）
            let startGate = startGates.find(
                (g) => this.convertLongToNumber(g.aoi_id) === startAOIId && g.type === travelMode
            );
            // 如果没找到完全匹配的，且是walking模式，则查找driving类型的gate
            if (!startGate && travelMode === "walking") {
                startGate = startGates.find(
                    (g) => this.convertLongToNumber(g.aoi_id) === startAOIId && g.type === "driving"
                );
            }

            let endGate = endGates.find(
                (g) => this.convertLongToNumber(g.aoi_id) === endAOIId && g.type === travelMode
            );
            // 如果没找到完全匹配的，且是walking模式，则查找driving类型的gate
            if (!endGate && travelMode === "walking") {
                endGate = endGates.find(
                    (g) => this.convertLongToNumber(g.aoi_id) === endAOIId && g.type === "driving"
                );
            }

            if (!startGate) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `错误：起点道路 ${startRoadId} 没有连接到AOI ${startAOIId} 的gate信息`,
                        },
                    ],
                    isError: true,
                };
            }

            if (!endGate) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `错误：终点道路 ${endRoadId} 没有连接到AOI ${endAOIId} 的gate信息`,
                        },
                    ],
                    isError: true,
                };
            }

            // gate查找逻辑已经确保了类型兼容性，这里只需要记录实际使用的gate类型
            this.session.logger.info({
                id: LogId.shortestPathStart,
                context: "shortestPathFromGates",
                message: `使用起点gate类型: ${startGate.type}, 终点gate类型: ${endGate.type}`,
            });

            // 获取所有道路（根据通行类型过滤）
            const excludedCategories = travelMode === "driving" ? ["footway", "cycleway", "steps"] : [];
            const roadMatchCondition: any = {
                "geometry.type": "LineString",
                from_junction: { $exists: true },
                to_junction: { $exists: true },
            };

            if (excludedCategories.length > 0) {
                roadMatchCondition.catg = { $nin: excludedCategories };
            }

            const allRoads = await provider
                .aggregate(database, collection, [
                    { $match: roadMatchCondition },
                    {
                        $project: {
                            _id: 0,
                            id: 1,
                            from_junction: 1,
                            to_junction: 1,
                            length: 1,
                            name: 1,
                            catg: 1,
                            max_speed: 1,
                            geometry: 1,
                        },
                    },
                ])
                .toArray();

            this.session.logger.info({
                id: LogId.shortestPathGraphSize,
                context: "shortestPathFromGates",
                message: `加载了 ${allRoads.length} 条道路（通行类型: ${travelMode}）`,
            });

            // 查询所有具有相同gate坐标的道路（双向道路）
            // 这样可以确保无论用户选择哪个方向的道路，结果都一致
            const startGateRoads = await this.findRoadsWithSameGate(
                provider,
                database,
                collection,
                startGate.coordinates,
                startAOIId
            );
            
            const endGateRoads = await this.findRoadsWithSameGate(
                provider,
                database,
                collection,
                endGate.coordinates,
                endAOIId
            );

            // 处理起点和终点道路的裁剪
            const processedRoads = this.splitRoadsAtGates(
                allRoads,
                startRoad!,
                endRoad!,
                startGateRoads,
                endGateRoads,
                startGate,
                endGate,
                travelMode
            );

            // 构建邻接表
            const graph = new Map<number, Array<{ to: number; weight: number; roadId: number }>>();
            const roadMap = new Map<number, RoadEdge>();
            const junctionSet = new Set<number>();

            for (const road of processedRoads.roads) {
                const edge: RoadEdge = {
                    id: road.id,
                    from_junction: road.from_junction,
                    to_junction: road.to_junction,
                    length: road.length,
                    cost: road.cost,
                    name: road.name,
                    catg: road.catg,
                    max_speed: road.max_speed,
                };

                roadMap.set(edge.id, edge);
                junctionSet.add(edge.from_junction);
                junctionSet.add(edge.to_junction);

                // 根据出行模式和权重字段计算权重
                let weight: number;
                if (travelMode === "walking") {
                    // 步行模式：统一使用 length / 步行速度
                    weight = edge.length / ShortestPathFromGatesTool.WALKING_SPEED;
                } else {
                    // 驾车模式：根据 weightField 选择
                    weight = weightField === "cost" ? edge.cost : edge.length;
                }

                if (!graph.has(edge.from_junction)) {
                    graph.set(edge.from_junction, []);
                }
                graph.get(edge.from_junction)!.push({
                    to: edge.to_junction,
                    weight: weight,
                    roadId: edge.id,
                });
            }

            // Dijkstra算法
            const result = this.dijkstra(
                graph,
                processedRoads.startJunction,
                processedRoads.endJunction,
                roadMap
            );

            const computationTime = Date.now() - startTime;
            result.statistics = {
                visitedJunctions: result.statistics?.visitedJunctions || 0,
                totalJunctions: junctionSet.size,
                totalRoads: processedRoads.roads.length,
                computationTimeMs: computationTime,
            };

            if (!result.found) {
                return {
                    content: formatUntrustedData(
                        `未找到从道路 ${startRoadId} (AOI ${startAOIId}) 到道路 ${endRoadId} (AOI ${endAOIId}) 的${travelMode === "driving" ? "驾车" : "步行"}路径`,
                        JSON.stringify(result.statistics, null, 2)
                    ),
                };
            }

            // 格式化结果
            const response: any = {
                found: true,
                startRoadId,
                endRoadId,
                startAOIId,
                endAOIId,
                travelMode: travelMode === "driving" ? "驾车" : "步行",
                weightField: weightField === "cost" ? "时间最短" : "距离最短",
                path: result.path,
                totalDistance: `${result.totalDistance?.toFixed(2)} 米`,
                totalCost: `${result.totalCost?.toFixed(2)} 秒`,
                estimatedTime: this.formatTime(result.totalCost || 0),
                statistics: result.statistics,
            };

            if (includeRoadDetails && result.roads) {
                response.roads = this.mergeConsecutiveRoads(result.roads);
            }

            this.session.logger.info({
                id: LogId.shortestPathComplete,
                context: "shortestPathFromGates",
                message: `最短路径计算完成: ${result.path?.length} 个路口, ${result.roads?.length} 条道路（合并为 ${response.roads?.length} 条）, ${computationTime}ms`,
            });

            return {
                content: formatUntrustedData(`从AOI gate出入口的最短路径查询结果`, JSON.stringify(response, null, 2)),
            };
        } catch (error) {
            this.session.logger.error({
                id: LogId.shortestPathError,
                context: "shortestPathFromGates",
                message: `最短路径计算失败: ${error}`,
            });
            return this.handleError(error, arguments[0]);
        }
    }

    /**
     * 检查两个坐标是否相同（考虑浮点精度）
     */
    private coordinatesEqual(coord1: number[], coord2: number[], tolerance: number = 0.00001): boolean {
        if (coord1.length !== coord2.length) return false;
        return this.calculateDistance(coord1, coord2) < tolerance;
    }

    /**
     * 查询所有具有相同gate坐标的道路（用于处理双向道路）
     */
    private async findRoadsWithSameGate(
        provider: any,
        database: string,
        collection: string,
        gateCoordinates: number[],
        aoiId: number
    ): Promise<any[]> {
        // 构建查询条件：gate数组中至少有一个元素的aoi_id和coordinates都匹配
        const tolerance = 0.00001; // 坐标容差（约1米）
        
        const roads = await provider
            .aggregate(database, collection, [
                {
                    $match: {
                        "gate.aoi_id": aoiId,
                    },
                },
                {
                    $project: {
                        _id: 0,
                        id: 1,
                        from_junction: 1,
                        to_junction: 1,
                        length: 1,
                        name: 1,
                        catg: 1,
                        max_speed: 1,
                        gate: 1,
                        geometry: 1,
                    },
                },
            ])
            .toArray();

        // 在内存中过滤：检查gate坐标是否匹配
        return roads.filter((road: any) => {
            const gates = (road.gate || []) as Gate[];
            return gates.some((gate: Gate) => {
                if (this.convertLongToNumber(gate.aoi_id) !== aoiId) return false;
                return this.coordinatesEqual(gate.coordinates, gateCoordinates, tolerance);
            });
        });
    }

    /**
     * 在gate处分割道路，并添加剩余道路，得到用于指定起始点和终点的道路列表
     */
    private splitRoadsAtGates(
        allRoads: any[],
        startRoad: any,
        endRoad: any,
        startGateRoads: any[],
        endGateRoads: any[],
        startGate: Gate,
        endGate: Gate,
        travelMode: "driving" | "walking"
    ): {
        roads: RoadEdge[];
        startJunction: number;
        endJunction: number;
    } {
        const roads: RoadEdge[] = [];
        let startJunction: number;
        let endJunction: number;
        
        // 用于跟踪哪些道路已被处理（避免重复处理双向道路）
        const processedRoadIds = new Set<number>();

        // 处理起点道路（包含所有具有相同gate坐标的双向道路）
        const startRoadCoords = startRoad.geometry?.coordinates || [];
        const isStartGateAtEndpoint = this.isGateAtEndpoint(startGate.coordinates, startRoadCoords);

        if (isStartGateAtEndpoint) {
            // Gate在端点上，不需要分割
            const fromJunc = this.convertLongToNumber(startRoad.from_junction);
            const toJunc = this.convertLongToNumber(startRoad.to_junction);

            const distToFrom = this.calculateDistance(startGate.coordinates, startRoadCoords[0]);
            const distToTo = this.calculateDistance(startGate.coordinates, startRoadCoords[startRoadCoords.length - 1]);

            startJunction = distToFrom < distToTo ? fromJunc : toJunc;

            // 处理所有具有相同gate坐标的道路（双向道路）
            for (const road of startGateRoads) {
                const roadId = this.convertLongToNumber(road.id);
                const roadLength = Number(road.length);
                const maxSpeed = Number(road.max_speed);
                const roadFromJunc = this.convertLongToNumber(road.from_junction);
                const roadToJunc = this.convertLongToNumber(road.to_junction);

                roads.push({
                    id: roadId,
                    from_junction: roadFromJunc,
                    to_junction: roadToJunc,
                    length: roadLength,
                    cost: this.calculateRoadCost(roadLength, maxSpeed, travelMode),
                    name: road.name,
                    catg: road.catg,
                    max_speed: maxSpeed,
                });
                
                processedRoadIds.add(roadId);
            }
        } else {
            // Gate不在端点，需要分割
            // 所有具有相同gate坐标的道路使用同一个新junction
            startJunction = ShortestPathFromGatesTool.GATE_JUNCTION_ID_START + this.gateJunctionCounter++;

            // 处理所有具有相同gate坐标的道路（双向道路）
            for (const road of startGateRoads) {
                const roadId = this.convertLongToNumber(road.id);
                const roadCoords = road.geometry?.coordinates || [];
                const originalLength = Number(road.length);
                const maxSpeed = Number(road.max_speed);
                const fromJunc = this.convertLongToNumber(road.from_junction);
                const toJunc = this.convertLongToNumber(road.to_junction);

                // 找到这条道路上对应的gate坐标
                const gates = (road.gate || []) as Gate[];
                const matchingGate = gates.find((g: Gate) => this.coordinatesEqual(g.coordinates, startGate.coordinates));
                if (!matchingGate) continue;

                // 计算gate到两个端点的距离比例
                const distToFrom = this.calculateDistance(matchingGate.coordinates, roadCoords[0]);
                const distToTo = this.calculateDistance(matchingGate.coordinates, roadCoords[roadCoords.length - 1]);
                const totalDist = distToFrom + distToTo;

                const ratioToFrom = distToFrom / totalDist;
                const ratioToTo = distToTo / totalDist;

                const lengthToFrom = originalLength * ratioToFrom;
                const lengthToTo = originalLength * ratioToTo;

                // 分割为两段
                roads.push({
                    id: roadId + 10000000000,
                    from_junction: fromJunc,
                    to_junction: startJunction,
                    length: lengthToFrom,
                    cost: this.calculateRoadCost(lengthToFrom, maxSpeed, travelMode),
                    name: road.name,
                    catg: road.catg,
                    max_speed: maxSpeed,
                });

                roads.push({
                    id: roadId + 20000000000,
                    from_junction: startJunction,
                    to_junction: toJunc,
                    length: lengthToTo,
                    cost: this.calculateRoadCost(lengthToTo, maxSpeed, travelMode),
                    name: road.name,
                    catg: road.catg,
                    max_speed: maxSpeed,
                });
                
                processedRoadIds.add(roadId);
            }
        }

        // 处理终点道路（包含所有具有相同gate坐标的双向道路）
        const endRoadCoords = endRoad.geometry?.coordinates || [];
        const isEndGateAtEndpoint = this.isGateAtEndpoint(endGate.coordinates, endRoadCoords);

        if (isEndGateAtEndpoint) {
            const fromJunc = this.convertLongToNumber(endRoad.from_junction);
            const toJunc = this.convertLongToNumber(endRoad.to_junction);

            const distToFrom = this.calculateDistance(endGate.coordinates, endRoadCoords[0]);
            const distToTo = this.calculateDistance(endGate.coordinates, endRoadCoords[endRoadCoords.length - 1]);

            endJunction = distToFrom < distToTo ? fromJunc : toJunc;

            // 处理所有具有相同gate坐标的道路（双向道路）
            for (const road of endGateRoads) {
                const roadId = this.convertLongToNumber(road.id);
                
                // 避免重复添加已处理的道路
                if (processedRoadIds.has(roadId)) continue;

                const roadLength = Number(road.length);
                const maxSpeed = Number(road.max_speed);
                const roadFromJunc = this.convertLongToNumber(road.from_junction);
                const roadToJunc = this.convertLongToNumber(road.to_junction);

                roads.push({
                    id: roadId,
                    from_junction: roadFromJunc,
                    to_junction: roadToJunc,
                    length: roadLength,
                    cost: this.calculateRoadCost(roadLength, maxSpeed, travelMode),
                    name: road.name,
                    catg: road.catg,
                    max_speed: maxSpeed,
                });
                
                processedRoadIds.add(roadId);
            }
        } else {
            endJunction = ShortestPathFromGatesTool.GATE_JUNCTION_ID_START + this.gateJunctionCounter++;

            // 处理所有具有相同gate坐标的道路（双向道路）
            for (const road of endGateRoads) {
                const roadId = this.convertLongToNumber(road.id);
                
                // 避免重复添加已处理的道路
                if (processedRoadIds.has(roadId)) continue;

                const roadCoords = road.geometry?.coordinates || [];
                const originalLength = Number(road.length);
                const maxSpeed = Number(road.max_speed);
                const fromJunc = this.convertLongToNumber(road.from_junction);
                const toJunc = this.convertLongToNumber(road.to_junction);

                // 找到这条道路上对应的gate坐标
                const gates = (road.gate || []) as Gate[];
                const matchingGate = gates.find((g: Gate) => this.coordinatesEqual(g.coordinates, endGate.coordinates));
                if (!matchingGate) continue;

                // 计算gate到两个端点的距离比例
                const distToFrom = this.calculateDistance(matchingGate.coordinates, roadCoords[0]);
                const distToTo = this.calculateDistance(matchingGate.coordinates, roadCoords[roadCoords.length - 1]);
                const totalDist = distToFrom + distToTo;

                const ratioToFrom = distToFrom / totalDist;
                const ratioToTo = distToTo / totalDist;

                const lengthToFrom = originalLength * ratioToFrom;
                const lengthToTo = originalLength * ratioToTo;

                roads.push({
                    id: roadId + 10000000000,
                    from_junction: fromJunc,
                    to_junction: endJunction,
                    length: lengthToFrom,
                    cost: this.calculateRoadCost(lengthToFrom, maxSpeed, travelMode),
                    name: road.name,
                    catg: road.catg,
                    max_speed: maxSpeed,
                });

                roads.push({
                    id: roadId + 20000000000,
                    from_junction: endJunction,
                    to_junction: toJunc,
                    length: lengthToTo,
                    cost: this.calculateRoadCost(lengthToTo, maxSpeed, travelMode),
                    name: road.name,
                    catg: road.catg,
                    max_speed: maxSpeed,
                });
                
                processedRoadIds.add(roadId);
            }
        }

        // 添加其他所有道路
        for (const road of allRoads) {
            const roadId = this.convertLongToNumber(road.id);

            // 跳过已处理的道路（包括起点、终点及其双向道路）
            if (processedRoadIds.has(roadId)) continue;

            const roadLength = Number(road.length);
            const maxSpeed = Number(road.max_speed);

            roads.push({
                id: roadId,
                from_junction: this.convertLongToNumber(road.from_junction),
                to_junction: this.convertLongToNumber(road.to_junction),
                length: roadLength,
                cost: this.calculateRoadCost(roadLength, maxSpeed, travelMode),
                name: road.name,
                catg: road.catg,
                max_speed: maxSpeed,
            });
        }

        return { roads, startJunction, endJunction };
    }

    /**
     * Dijkstra最短路径算法
     */
    private dijkstra(
        graph: Map<number, Array<{ to: number; weight: number; roadId: number }>>,
        start: number,
        end: number,
        roadMap: Map<number, RoadEdge>
    ): ShortestPathResult {
        const distances = new Map<number, number>();
        const previous = new Map<number, { junction: number; roadId: number }>();
        const visited = new Set<number>();
        const pq = new PriorityQueue();

        distances.set(start, 0);
        pq.push({ junctionId: start, cost: 0 });

        let visitedCount = 0;

        while (!pq.isEmpty()) {
            const current = pq.pop();
            if (!current) break;

            const { junctionId, cost } = current;

            if (visited.has(junctionId)) continue;
            visited.add(junctionId);
            visitedCount++;

            // 找到目标
            if (junctionId === end) {
                break;
            }

            // 松弛操作
            const neighbors = graph.get(junctionId) || [];
            for (const { to, weight, roadId } of neighbors) {
                if (visited.has(to)) continue;

                const newDistance = cost + weight;
                const currentDistance = distances.get(to) ?? Infinity;

                if (newDistance < currentDistance) {
                    distances.set(to, newDistance);
                    previous.set(to, { junction: junctionId, roadId });
                    pq.push({ junctionId: to, cost: newDistance });
                }
            }
        }

        // 回溯路径
        if (!distances.has(end)) {
            return {
                found: false,
                statistics: {
                    visitedJunctions: visitedCount,
                    totalJunctions: 0,
                    totalRoads: 0,
                    computationTimeMs: 0,
                },
            };
        }

        const path: number[] = [];
        const roads: RoadEdge[] = [];
        let current = end;

        while (current !== start) {
            path.unshift(current);
            const prev = previous.get(current);
            if (!prev) break;
            const road = roadMap.get(prev.roadId);
            if (road) {
                roads.unshift(road);
            }
            current = prev.junction;
        }
        path.unshift(start);

        // 计算总距离和总时间
        let totalDistance = 0;
        let totalCost = 0;
        for (const road of roads) {
            totalDistance += road.length;
            totalCost += road.cost;
        }

        return {
            found: true,
            path,
            roads,
            totalDistance,
            totalCost,
            statistics: {
                visitedJunctions: visitedCount,
                totalJunctions: 0,
                totalRoads: 0,
                computationTimeMs: 0,
            },
        };
    }

    /**
     * 合并连续的同名道路段
     */
    private mergeConsecutiveRoads(roads: RoadEdge[]): any[] {
        if (roads.length === 0) return [];

        const mergedRoads: any[] = [];
        let currentGroup: RoadEdge[] = [roads[0]!];

        for (let i = 1; i < roads.length; i++) {
            const currentRoad = roads[i]!;
            const lastInGroup = currentGroup[currentGroup.length - 1]!;

            // 检查是否可以合并：名称相同且连续
            if (
                currentRoad.name === lastInGroup.name &&
                currentRoad.catg === lastInGroup.catg &&
                currentRoad.max_speed === lastInGroup.max_speed &&
                currentRoad.from_junction === lastInGroup.to_junction
            ) {
                // 可以合并，添加到当前组
                currentGroup.push(currentRoad);
            } else {
                // 不能合并，处理当前组并开始新组
                mergedRoads.push(this.createMergedRoadSegment(currentGroup));
                currentGroup = [currentRoad];
            }
        }

        // 处理最后一组
        mergedRoads.push(this.createMergedRoadSegment(currentGroup));

        return mergedRoads;
    }

    /**
     * 创建合并后的道路段
     */
    private createMergedRoadSegment(roadGroup: RoadEdge[]): any {
        if (roadGroup.length === 0) {
            throw new Error("道路组不能为空");
        }

        const firstRoad = roadGroup[0]!;
        const lastRoad = roadGroup[roadGroup.length - 1]!;

        // 计算总距离和总时间
        const totalDistance = roadGroup.reduce((sum, road) => sum + road.length, 0);
        const totalTime = roadGroup.reduce((sum, road) => sum + road.cost, 0);

        return {
            roadIds: roadGroup.map(road => road.id), // 改为ID列表
            from: firstRoad.from_junction,
            to: lastRoad.to_junction,
            name: firstRoad.name || "未命名道路",
            category: firstRoad.catg,
            distance: `${totalDistance.toFixed(2)} 米`,
            time: `${totalTime.toFixed(2)} 秒`,
            maxSpeed: firstRoad.max_speed ? `${(firstRoad.max_speed * 3.6).toFixed(1)} km/h` : "未知",
            segmentCount: roadGroup.length, // 添加段数信息
        };
    }

    /**
     * 格式化时间
     */
    private formatTime(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        const parts: string[] = [];
        if (hours > 0) parts.push(`${hours}小时`);
        if (minutes > 0) parts.push(`${minutes}分钟`);
        if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);

        return parts.join("");
    }
}

