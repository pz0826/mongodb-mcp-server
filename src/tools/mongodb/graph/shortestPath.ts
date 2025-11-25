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
            if (rightChild < this.heap.length && rightNode && this.heap[minIndex] && rightNode.cost < this.heap[minIndex]!.cost) {
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
 * 最短路径结果
 */
interface ShortestPathResult {
    found: boolean;
    path?: number[]; // 路口ID序列
    roads?: RoadEdge[]; // 道路详情
    totalDistance?: number; // 总距离（米）
    totalCost?: number; // 总时间（秒）
    statistics?: {
        visitedJunctions: number;
        totalJunctions: number;
        totalRoads: number;
        computationTimeMs: number;
    };
}

export const ShortestPathArgs = {
    startJunction: z.number().describe("起点路口ID（junction id）"),
    endJunction: z.number().describe("终点路口ID（junction id）"),
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
 * 最短路径查询工具（使用Dijkstra算法）
 */
export class ShortestPathTool extends MongoDBToolBase {
    public name = "shortest_path";
    protected description =
        "使用Dijkstra算法计算路网中两个路口之间的最短路径。支持按时间最短或距离最短进行查询。";
    protected argsShape = {
        ...DbOperationArgs,
        ...ShortestPathArgs,
    };
    public operationType: OperationType = "read";

    /**
     * 将MongoDB Long类型转换为Number
     */
    private convertLongToNumber(value: any): number {
        if (value && typeof value === 'object' && 'low' in value && 'high' in value) {
            // Long类型转换：value = low + high * 2^32
            return value.high * 4294967296 + (value.low >>> 0);
        }
        return Number(value);
    }

    protected async execute(
        { database, collection, startJunction, endJunction, weightField, includeRoadDetails }: ToolArgs<typeof this.argsShape>,
        { signal }: ToolExecutionContext
    ): Promise<CallToolResult> {
        const startTime = Date.now();

        try {
            const provider = await this.ensureConnected();

            this.session.logger.info({
                id: LogId.shortestPathStart,
                context: "shortestPath",
                message: `开始计算最短路径: ${startJunction} -> ${endJunction}, 权重字段: ${weightField}`,
            });

            // 检查起点和终点是否存在
            const junctionsCheck = await provider
                .aggregate(database, collection, [
                    {
                        $match: {
                            "id": { $in: [startJunction, endJunction] },
                            "geometry.type": "Point",
                        },
                    },
                    {
                        $project: {
                            "id": 1,
                        },
                    },
                ])
                .toArray();

            if (junctionsCheck.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `错误：在集合 ${database}.${collection} 中未找到路口 ${startJunction} 或 ${endJunction}`,
                        },
                    ],
                    isError: true,
                };
            }

            // 将Long类型转换为Number（MongoDB返回的ID可能是Long类型）
            const foundJunctions = junctionsCheck.map((j: any) => this.convertLongToNumber(j.id));
            
            this.session.logger.info({
                id: LogId.shortestPathGraphSize,
                context: "shortestPath",
                message: `查询到 ${junctionsCheck.length} 个路口，转换后的ID: ${JSON.stringify(foundJunctions)}`,
            });
            
            if (!foundJunctions.includes(startJunction)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `错误：未找到起点路口 ${startJunction}`,
                        },
                    ],
                    isError: true,
                };
            }
            if (!foundJunctions.includes(endJunction)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `错误：未找到终点路口 ${endJunction}`,
                        },
                    ],
                    isError: true,
                };
            }

            // 获取所有道路数据（LineString类型的feature）
            const roads = await provider
                .aggregate(database, collection, [
                    {
                        $match: {
                            "geometry.type": "LineString",
                            "from_junction": { $exists: true },
                            "to_junction": { $exists: true },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            id: 1,
                            from_junction: 1,
                            to_junction: 1,
                            length: 1,
                            cost: 1,
                            name: 1,
                            catg: 1,
                            max_speed: 1,
                        },
                    },
                ])
                .toArray();

            if (roads.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `错误：集合 ${database}.${collection} 中没有找到任何道路数据`,
                        },
                    ],
                    isError: true,
                };
            }

            this.session.logger.info({
                id: LogId.shortestPathGraphSize,
                context: "shortestPath",
                message: `加载了 ${roads.length} 条道路`,
            });

            // 构建邻接表
            const graph = new Map<number, Array<{ to: number; weight: number; roadId: number }>>();
            const roadMap = new Map<number, RoadEdge>();
            const junctionSet = new Set<number>();

            for (const road of roads) {
                const edge: RoadEdge = {
                    id: this.convertLongToNumber(road.id),
                    from_junction: this.convertLongToNumber(road.from_junction),
                    to_junction: this.convertLongToNumber(road.to_junction),
                    length: Number(road.length),
                    cost: Number(road.cost),
                    name: road.name,
                    catg: road.catg,
                    max_speed: Number(road.max_speed),
                };

                roadMap.set(edge.id, edge);
                junctionSet.add(edge.from_junction);
                junctionSet.add(edge.to_junction);

                const weight = weightField === "cost" ? edge.cost : edge.length;

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
            const result = this.dijkstra(graph, startJunction, endJunction, roadMap, weightField);
            
            const computationTime = Date.now() - startTime;
            result.statistics = {
                visitedJunctions: result.statistics?.visitedJunctions || 0,
                totalJunctions: junctionSet.size,
                totalRoads: roads.length,
                computationTimeMs: computationTime,
            };

            if (!result.found) {
                return {
                    content: formatUntrustedData(
                        `未找到从路口 ${startJunction} 到路口 ${endJunction} 的路径`,
                        JSON.stringify(result.statistics, null, 2)
                    ),
                };
            }

            // 格式化结果
            const response: any = {
                found: true,
                startJunction,
                endJunction,
                weightField,
                path: result.path,
                totalDistance: `${result.totalDistance?.toFixed(2)} 米`,
                totalCost: `${result.totalCost?.toFixed(2)} 秒`,
                estimatedTime: this.formatTime(result.totalCost || 0),
                statistics: result.statistics,
            };

            if (includeRoadDetails && result.roads) {
                response.roads = result.roads.map((road, index) => ({
                    step: index + 1,
                    roadId: road.id,
                    from: road.from_junction,
                    to: road.to_junction,
                    name: road.name || "未命名道路",
                    category: road.catg,
                    distance: `${road.length.toFixed(2)} 米`,
                    time: `${road.cost.toFixed(2)} 秒`,
                    maxSpeed: road.max_speed ? `${(road.max_speed * 3.6).toFixed(1)} km/h` : "未知",
                }));
            }

            this.session.logger.info({
                id: LogId.shortestPathComplete,
                context: "shortestPath",
                message: `最短路径计算完成: ${result.path?.length} 个路口, ${result.roads?.length} 条道路, ${computationTime}ms`,
            });

            return {
                content: formatUntrustedData(
                    `最短路径查询结果`,
                    JSON.stringify(response, null, 2)
                ),
            };
        } catch (error) {
            this.session.logger.error({
                id: LogId.shortestPathError,
                context: "shortestPath",
                message: `最短路径计算失败: ${error}`,
            });
            return this.handleError(error, arguments[0]);
        }
    }

    /**
     * Dijkstra最短路径算法
     */
    private dijkstra(
        graph: Map<number, Array<{ to: number; weight: number; roadId: number }>>,
        start: number,
        end: number,
        roadMap: Map<number, RoadEdge>,
        weightField: "cost" | "length"
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

