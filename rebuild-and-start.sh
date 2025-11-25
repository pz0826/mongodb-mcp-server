#!/bin/bash

# MongoDB MCP Server 重新构建和启动脚本
# 使用方法: ./rebuild-and-start.sh [mode] [transport_type]
# mode 可选值:
#   - ob (only build)  - 只构建，不启动
#   - os (only start)  - 只启动，不构建
#   - 默认 - 构建并启动
# transport_type 可选值: http(默认) 或 stdio  

set -e  # 遇到错误立即退出

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 解析参数
MODE="build-and-start"  # 默认模式
TRANSPORT_TYPE="http"   # 默认传输类型

# 解析第一个参数
if [ -n "$1" ]; then
    case "$1" in
        ob|only-build)
            MODE="only-build"
            # 如果是 only-build，第二个参数会被忽略
            ;;
        os|only-start)
            MODE="only-start"
            # 第二个参数如果存在，作为传输类型
            if [ -n "$2" ]; then
                TRANSPORT_TYPE="$2"
            fi
            ;;
        stdio|http)
            # 如果第一个参数是传输类型，保持默认模式
            TRANSPORT_TYPE="$1"
            ;;
        *)
            echo -e "${RED}❌ 错误: 未知的模式或传输类型 '$1'${NC}"
            echo -e "${YELLOW}使用方法:${NC}"
            echo -e "  $0 stdio              # 构建并启动 (stdio)"
            echo -e "  $0 http               # 构建并启动 (http)"
            echo -e "  $0 ob                 # 只构建"
            echo -e "  $0 os [stdio|http]    # 只启动"
            exit 1
            ;;
    esac
fi

# 验证传输类型
if [ "$TRANSPORT_TYPE" != "stdio" ] && [ "$TRANSPORT_TYPE" != "http" ]; then
    echo -e "${RED}❌ 错误: 传输类型必须是 'stdio' 或 'http'${NC}"
    echo -e "${YELLOW}当前值: $TRANSPORT_TYPE${NC}"
    exit 1
fi

# 切换到脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 显示标题
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
case "$MODE" in
    only-build)
        echo -e "${BLUE}  MongoDB MCP Server 构建${NC}"
        ;;
    only-start)
        echo -e "${BLUE}  MongoDB MCP Server 启动 (${TRANSPORT_TYPE})${NC}"
        ;;
    *)
        echo -e "${BLUE}  MongoDB MCP Server 重新构建和启动${NC}"
        ;;
esac
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 根据模式执行相应操作
if [ "$MODE" = "only-build" ] || [ "$MODE" = "build-and-start" ]; then

    echo -e "${YELLOW}📦 清理旧的构建文件...${NC}"
    npm run build:clean
    echo -e "${GREEN}✓ 清理完成${NC}"
    echo ""

    echo -e "${YELLOW}🔨 重新编译 TypeScript 项目...${NC}"
    npm run build
    echo -e "${GREEN}✓ 构建完成${NC}"
    echo ""
fi

# 如果是 only-build 模式，到此结束
if [ "$MODE" = "only-build" ]; then
    echo -e "${GREEN}✅ 构建完成！使用 '$0 os [stdio|http]' 启动服务器${NC}"
    exit 0
fi

# 清理端口函数
cleanup_port() {
    local PORT=$1
    echo -e "${YELLOW}🔍 检查端口 ${PORT} 是否被占用...${NC}"
    
    # 查找占用端口的进程
    local PIDS=$(lsof -ti:${PORT} 2>/dev/null)
    
    if [ -n "$PIDS" ]; then
        echo -e "${YELLOW}⚠️  发现端口 ${PORT} 被占用，进程 PID: ${PIDS}${NC}"
        echo -e "${YELLOW}🛑 正在停止占用端口的进程...${NC}"
        
        # 强制停止进程
        echo "$PIDS" | xargs kill -9 2>/dev/null || true
        
        # 等待进程完全停止
        sleep 1
        
        # 再次检查
        PIDS=$(lsof -ti:${PORT} 2>/dev/null)
        if [ -z "$PIDS" ]; then
            echo -e "${GREEN}✓ 端口 ${PORT} 已清理${NC}"
        else
            echo -e "${RED}❌ 警告: 端口 ${PORT} 仍然被占用${NC}"
        fi
    else
        echo -e "${GREEN}✓ 端口 ${PORT} 可用${NC}"
    fi
    echo ""
}

# 清理可能存在的旧进程
cleanup_old_processes() {
    echo -e "${YELLOW}🧹 清理旧的 MongoDB MCP Server 进程...${NC}"
    
    # 查找并停止所有 mongodb-mcp-server 相关进程
    local PIDS=$(pgrep -f "mongodb-mcp-server" 2>/dev/null || true)
    
    if [ -n "$PIDS" ]; then
        echo -e "${YELLOW}⚠️  发现旧进程: ${PIDS}${NC}"
        echo "$PIDS" | xargs kill -9 2>/dev/null || true
        sleep 1
        echo -e "${GREEN}✓ 旧进程已清理${NC}"
    else
        echo -e "${GREEN}✓ 没有发现旧进程${NC}"
    fi
    echo ""
}

# 启动服务器
echo -e "${YELLOW}🚀 启动 MongoDB MCP Server (${TRANSPORT_TYPE} 模式)...${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 清理旧进程
cleanup_old_processes

# 如果是 HTTP 模式，清理 3000 端口
if [ "$TRANSPORT_TYPE" = "http" ]; then
    cleanup_port 3000
fi

# 从配置文件读取设置
CONFIG_FILE="$SCRIPT_DIR/config.json"

if [ -f "$CONFIG_FILE" ]; then
    echo -e "${YELLOW}📄 从配置文件加载设置: $CONFIG_FILE${NC}"
    
    # 使用 jq 读取配置（如果没有安装，使用默认值）
    if command -v jq &> /dev/null; then
        export MDB_MCP_CONNECTION_STRING=$(jq -r '.mongodb.connection_string' "$CONFIG_FILE")
        export MDB_MCP_READ_ONLY=$(jq -r '.mongodb.read_only' "$CONFIG_FILE")
        export MDB_MCP_LOGGERS=$(jq -r '.logging.loggers' "$CONFIG_FILE")
        echo -e "${GREEN}✓ 配置加载成功${NC}"
    else
        echo -e "${YELLOW}⚠️  未安装 jq，使用默认配置${NC}"
        export MDB_MCP_CONNECTION_STRING="mongodb://admin:mapdata123@localhost:27017/map_database?authSource=admin"
        export MDB_MCP_READ_ONLY="false"
        export MDB_MCP_LOGGERS="stderr,mcp"
    fi
else
    echo -e "${YELLOW}⚠️  配置文件不存在，使用默认配置${NC}"
    export MDB_MCP_CONNECTION_STRING="mongodb://admin:mapdata123@localhost:27017/map_database?authSource=admin"
    export MDB_MCP_READ_ONLY="false"
    export MDB_MCP_LOGGERS="stderr,mcp"
fi

echo ""

if [ "$TRANSPORT_TYPE" = "http" ]; then
    echo -e "${GREEN}启动 HTTP 服务器模式...${NC}"
    npm run start
else
    echo -e "${GREEN}启动 STDIO 服务器模式...${NC}"
    npm run start:stdio
fi

