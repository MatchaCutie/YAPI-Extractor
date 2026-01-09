# YAPI Extractor MCP Server

YAPI接口文档提取器MCP服务器，可以从YAPI接口文档自动生成mock数据和TypeScript类型定义。

## 功能特性

- 🔐 自动登录YAPI系统获取认证
- 📋 解析YAPI接口的JSON Schema
- 🎯 智能生成mock数据（支持YAPI mock语法）
- 📝 自动生成TypeScript类型定义
- 💾 支持自动保存文件到指定目录

## 安装

```bash
npm install
npm run build
```

## 配置

在Cline的MCP配置文件中配置环境变量（通过env字段）：

**必需的环境变量：**
- `YAPI_BASE_URL`: YAPI服务器地址
- `YAPI_EMAIL`: 登录邮箱
- `YAPI_PASSWORD`: 登录密码

**可选的环境变量：**
- `SAVE_FILES`: 是否自动保存文件 (`"true"` 或 `"false"`)
- `OUTPUT_DIR`: 文件保存目录路径

## 工具说明

### 1. extract_yapi_interface

从YAPI接口文档提取信息并生成mock数据和TypeScript类型定义。

**参数：**
- `interfaceId` (必需): YAPI接口ID
- `generateType` (可选): 生成类型，可选值：`mock`, `types`, `both`，默认 `both`
- `saveFiles` (可选): 是否保存生成的文件，默认 `false`

**示例：**
```json
{
  "interfaceId": "9769",
  "generateType": "both",
  "saveFiles": true
}
```

### 2. save_generated_files

保存生成的mock数据和类型定义文件到本地。

**参数：**
- `interfaceId` (必需): 接口ID，用于生成文件名前缀
- `mockData` (可选): mock JSON数据字符串
- `typeDefinitions` (可选): TypeScript类型定义字符串

**示例：**
```json
{
  "interfaceId": "9769",
  "mockData": "{\"code\": 200, \"msg\": \"success\"}",
  "typeDefinitions": "export interface Response { code: number; msg: string; }"
}
```

### 3. save_advanced_mock

保存高级mock数据到YAPI系统，支持创建多个mock场景。

**参数：**
- `interfaceId` (必需): YAPI接口ID
- `projectId` (必需): YAPI项目ID
- `name` (必需): mock场景名称，通常使用接口名称
- `mockData` (必需): mock数据的data部分（JSON字符串），不需要包含code和msg

**示例：**
```json
{
  "interfaceId": "9769",
  "projectId": "63",
  "name": "奖励弹窗",
  "mockData": "{\"reward\": {\"type\": 1, \"amount\": 100}}"
}
```

## MCP服务器配置

在Cline的MCP配置文件中添加：

```json
{
  "mcpServers": {
    "yapi-extractor": {
      "command": "node",
      "args": ["/path/to/yapi-mock-server/build/index.js"],
      "env": {
        "YAPI_BASE_URL": "http://your-yapi-server:3000",
        "YAPI_EMAIL": "your-email",
        "YAPI_PASSWORD": "your-password",
        "SAVE_FILES": "true",
        "OUTPUT_DIR": "/path/to/output/mock"
      }
    }
  }
}
```

## 使用流程

1. **启动MCP服务器**
   ```bash
   npm start
   ```

2. **调用extract_yapi_interface工具**
   - 传入YAPI接口ID
   - 指定生成类型（mock数据、类型定义或两者）
   - 可选择自动保存文件

3. **处理返回结果**
   - 服务器会自动登录YAPI
   - 解析接口的JSON Schema
   - 生成相应的mock数据和类型定义
   - 根据配置保存文件

## 输出文件格式

### Mock数据文件
- 文件名格式: `{interfaceId}-mock.json`
- 内容: 完整的JSON响应示例

### 类型定义文件
- 文件名格式: `{interfaceId}-types.ts`
- 内容: TypeScript接口定义

## 支持的YAPI Mock语法

- `@timestamp`: 生成当前时间戳
- `@pick([...])`: 从数组中随机选择值
- `min,max`: 生成指定范围内的数字

## 示例输出

对于ID为9769的"奖励弹窗"接口，会生成：

- `9769-mock.json`: 完整的奖励弹窗响应数据
- `9769-types.ts`: TypeScript类型定义

## 错误处理

服务器包含完善的错误处理机制：
- YAPI登录失败
- 接口不存在
- JSON Schema解析失败
- 文件保存失败

所有错误都会通过MCP协议返回详细的错误信息。

## 技术栈

- **运行时**: Node.js (ESM)
- **语言**: TypeScript
- **MCP SDK**: @modelcontextprotocol/sdk
- **HTTP客户端**: axios
- **环境变量**: dotenv

## 开发

```bash
# 安装依赖
npm install

# 开发模式运行
npm run dev

# 构建项目
npm run build

# 清理构建产物
npm run clean
```

## 目录结构

```
yapi-mock-server/
├── src/
│   └── index.ts        # MCP服务器主入口
├── build/              # 编译输出目录
├── mock/               # 默认mock文件输出目录
├── package.json
├── tsconfig.json
└── README.md
```

## 许可证

MIT
