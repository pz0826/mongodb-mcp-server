# MongoDB MCP Server 开发指南

## 🚀 快速开始

本项目提供了两个便捷的开发脚本来帮助您快速重新构建和启动服务器。

## 📝 可用脚本

### 1. `rebuild-and-start.sh` - 简单重建启动脚本

最简单的方式重新构建和启动服务器。

**使用方法:**
```bash
./rebuild-and-start.sh [stdio|http]
```

**示例:**
```bash
# 使用 STDIO 模式启动（默认）
./rebuild-and-start.sh

# 使用 HTTP 模式启动
./rebuild-and-start.sh http
```

**功能:**
- ✅ 清理旧的构建文件
- ✅ 重新编译 TypeScript 代码
- ✅ 启动服务器

---

### 2. `dev.sh` - 增强开发脚本

提供更多灵活选项的开发脚本。

**使用方法:**
```bash
./dev.sh [选项] [传输类型]
```

**选项:**
- `-h, --help` : 显示帮助信息
- `-b, --build-only` : 仅构建，不启动服务器
- `-f, --fast` : 快速模式（跳过清理步骤）
- `-c, --clean-only` : 仅清理构建文件
- `-i, --inspect` : 使用 inspector 模式启动（用于调试）

**传输类型:**
- `stdio` : STDIO 传输模式（默认）
- `http` : HTTP 传输模式

**示例:**
```bash
# 完整构建并以 stdio 模式启动
./dev.sh

# 完整构建并以 http 模式启动
./dev.sh http

# 快速构建（跳过清理）并启动
./dev.sh -f stdio

# 仅构建，不启动
./dev.sh -b

# 使用 inspector 模式调试
./dev.sh -i

# 仅清理构建文件
./dev.sh -c
```

---

## 📦 使用 NPM Scripts

您也可以使用以下 npm 命令：

```bash
# 清理构建文件
npm run build:clean

# 完整构建
npm run build

# 启动 HTTP 模式
npm run start

# 启动 STDIO 模式
npm run start:stdio

# 使用 inspector 调试
npm run inspect

# 添加自定义脚本（可选）
npm run dev         # 相当于 ./dev.sh
npm run dev:fast    # 相当于 ./dev.sh -f
npm run dev:build   # 相当于 ./dev.sh -b
```

---

## 🔧 典型开发工作流

### 场景 1: 修改代码后测试
```bash
# 快速重建和启动（跳过清理以节省时间）
./dev.sh -f
```

### 场景 2: 完整重建（清理一切）
```bash
# 完整构建流程
./rebuild-and-start.sh
# 或
./dev.sh
```

### 场景 3: 仅构建不启动
```bash
# 适合需要手动启动或其他自定义操作
./dev.sh -b
```

### 场景 4: 使用 Inspector 调试
```bash
# 启动 MCP Inspector 进行调试
./dev.sh -i
```

### 场景 5: 清理构建产物
```bash
# 仅清理
./dev.sh -c
```

---

## 🌐 HTTP 模式说明

当使用 HTTP 模式启动时：
- 默认地址：`http://127.0.0.1:3000`
- 可以通过环境变量自定义：
  - `MDB_MCP_HTTP_HOST` - 主机地址
  - `MDB_MCP_HTTP_PORT` - 端口号

**示例:**
```bash
export MDB_MCP_HTTP_PORT=8080
./rebuild-and-start.sh http
```

---

## ⚙️ 环境配置

在启动服务器之前，请确保配置了必要的环境变量：

### MongoDB 连接字符串
```bash
export MDB_MCP_CONNECTION_STRING="mongodb://localhost:27017/myDatabase"
```

### Atlas API 凭证
```bash
export MDB_MCP_API_CLIENT_ID="your-client-id"
export MDB_MCP_API_CLIENT_SECRET="your-client-secret"
```

### 只读模式
```bash
export MDB_MCP_READ_ONLY="true"
```

详细配置请参考主 [README.md](README.md)

---

## 🐛 故障排除

### 构建失败
```bash
# 清理并重新安装依赖
rm -rf node_modules package-lock.json
npm install
./rebuild-and-start.sh
```

### 端口被占用（HTTP 模式）
```bash
# 使用不同端口
export MDB_MCP_HTTP_PORT=8080
./rebuild-and-start.sh http
```

### TypeScript 编译错误
```bash
# 检查 TypeScript 类型错误
npm run check:types

# 修复 lint 问题
npm run fix
```

---

## 📚 更多资源

- [主 README](README.md) - 完整的配置和使用说明
- [贡献指南](CONTRIBUTING.md) - 如何为项目做贡献
- [MCP 文档](https://modelcontextprotocol.io/) - Model Context Protocol 官方文档

---

## 💡 提示

1. **开发时使用快速模式** - 修改代码后使用 `./dev.sh -f` 可以节省清理时间
2. **首次运行使用完整构建** - 确保所有内容都是最新的
3. **使用 Inspector 调试** - 遇到问题时使用 `./dev.sh -i` 进行调试
4. **定期清理** - 偶尔运行 `./dev.sh -c` 清理旧的构建产物

---

祝开发愉快！🎉

