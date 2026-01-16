#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import { fileURLToPath } from "url";

// 获取当前模块所在目录（ESM 中替代 __dirname）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 项目根目录（src 的上一级）
const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * 解析输出目录路径
 * - 绝对路径：直接使用
 * - 相对路径：相对于项目根目录解析
 */
function resolveOutputDir(outputDir: string): string {
  if (path.isAbsolute(outputDir)) {
    return outputDir;
  }
  // 相对路径，相对于项目根目录解析
  return path.resolve(PROJECT_ROOT, outputDir);
}

// 环境配置 - 从MCP服务器配置的env字段读取
const CONFIG = {
  YAPI_BASE_URL: process.env.YAPI_BASE_URL,
  YAPI_EMAIL: process.env.YAPI_EMAIL,
  YAPI_PASSWORD: process.env.YAPI_PASSWORD,
  SAVE_FILES: process.env.SAVE_FILES === "true",
  OUTPUT_DIR: process.env.OUTPUT_DIR || "mock", // 默认相对路径
};

interface YapiLoginResponse {
  errcode: number;
  errmsg: string;
  data: {
    username: string;
    role: string;
    uid: number;
    email: string;
  };
}

interface YapiInterfaceResponse {
  errcode: number;
  errmsg: string;
  data: {
    _id: number;
    project_id: number;
    title: string;
    method: string;
    path: string;
    res_body: string;
    res_body_type: string;
  };
}

interface JsonSchema {
  type: string;
  properties?: Record<string, any>;
  items?: any;
  description?: string;
  mock?: any;
  enum?: any[];
  enumDesc?: string;
}

class YapiExtractorServer {
  private server: Server;
  private cookies: string[] = [];
  private isLoggedIn = false;

  constructor() {
    this.validateConfig();

    this.server = new Server({
      name: "yapi-extractor",
      version: "1.0.0",
    });

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private validateConfig() {
    const required = ["YAPI_BASE_URL", "YAPI_EMAIL", "YAPI_PASSWORD"] as const;
    const missing = required.filter(key => !CONFIG[key]);
    if (missing.length > 0) {
      throw new Error(`缺少环境变量: ${missing.join(", ")}`);
    }
  }

  private setupToolHandlers() {
    // 列出可用的工具
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "extract_yapi_interface",
            description: "从YAPI接口文档获取返回数据类型，然后解析接口结构并返回分析结果JSON Schema",
            inputSchema: {
              type: "object",
              properties: {
                interfaceId: {
                  type: "string",
                  description: "YAPI接口ID，从接口URL中提取，如http://your-yapi-server:3000/project/63/interface/api/9084中的9084",
                },
                generateType: {
                  type: "string",
                  enum: ["mock", "types", "both"],
                  description: "生成内容类型：'mock'表示只生成JSON格式的mock数据，'types'表示只生成TypeScript类型定义，'both'表示同时生成mock数据和类型定义，根据用户描述，判断传参枚举",
                  default: "both",
                },
              },
              required: ["interfaceId"],
            },
          },
          {
            name: "save_generated_files",
            description: "保存生成的mock数据和类型定义文件到本地",
            inputSchema: {
              type: "object",
              properties: {
                interfaceId: {
                  type: "string",
                  description: "接口ID，用于生成文件名前缀",
                },
                mockData: {
                  type: "string",
                  description: "mock JSON数据字符串",
                },
                typeDefinitions: {
                  type: "string",
                  description: "TypeScript类型定义字符串",
                },
              },
              required: ["interfaceId"],
            },
          },
          {
            name: "save_advanced_mock",
            description: "保存高级mock数据到YAPI系统",
            inputSchema: {
              type: "object",
              properties: {
                interfaceId: {
                  type: "string",
                  description: "YAPI接口ID",
                },
                projectId: {
                  type: "string",
                  description: "YAPI项目ID",
                },
                name: {
                  type: "string",
                  description: "mock场景名称，通常使用接口名称",
                },
                mockData: {
                  type: "string",
                  description: "mock数据的data部分（JSON字符串），不需要包含code和msg",
                },
              },
              required: ["interfaceId", "projectId", "name", "mockData"],
            },
          },
        ],
      };
    });

    // 处理工具调用
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "extract_yapi_interface":
          return await this.handleExtractYapiInterface(args);
        case "save_generated_files":
          return await this.handleSaveGeneratedFiles(args);
        case "save_advanced_mock":
          return await this.handleSaveAdvancedMock(args);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
      }
    });
  }

  private async loginToYapi(): Promise<void> {
    // 已登录则跳过
    if (this.isLoggedIn && this.cookies.length > 0) {
      return;
    }

    try {
      const loginUrl = `${CONFIG.YAPI_BASE_URL}/api/user/login_by_ldap`;
      const response = await axios.post(
        loginUrl,
        {
          email: CONFIG.YAPI_EMAIL,
          password: CONFIG.YAPI_PASSWORD,
        },
        {
          timeout: 10000,
          headers: {
            "Content-Type": "application/json",
          },
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        }
      );

      const loginData: YapiLoginResponse = response.data;
      if (loginData.errcode !== 0) {
        throw new Error(`登录失败: ${loginData.errmsg}`);
      }

      // 保存cookies用于后续请求
      const cookies = response.headers["set-cookie"];
      if (cookies) {
        this.cookies = cookies;
        this.isLoggedIn = true;
      }
    } catch (error) {
      this.isLoggedIn = false;
      throw new Error(`登录YAPI失败: ${error}`);
    }
  }

  private async fetchInterfaceData(interfaceId: string): Promise<YapiInterfaceResponse> {
    try {
      const interfaceUrl = `${CONFIG.YAPI_BASE_URL}/api/interface/get?id=${interfaceId}`;

      const response = await axios.get(interfaceUrl, {
        timeout: 10000,
        headers: {
          Cookie: this.cookies.join("; "),
        },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });

      const interfaceData: YapiInterfaceResponse = response.data;
      if (interfaceData.errcode !== 0) {
        // session 过期，重新登录
        if (interfaceData.errcode === 40011) {
          this.isLoggedIn = false;
        }
        throw new Error(`获取接口数据失败: ${interfaceData.errmsg}`);
      }

      return interfaceData;
    } catch (error) {
      throw new Error(`获取接口数据失败: ${error}`);
    }
  }

  private parseJsonSchema(schemaString: string): JsonSchema {
    try {
      return JSON.parse(schemaString);
    } catch (error) {
      throw new Error(`解析JSON Schema失败: ${error}`);
    }
  }

  private async handleExtractYapiInterface(args: any) {
    const { interfaceId, generateType = "both" } = args;

    try {
      // 登录YAPI
      await this.loginToYapi();

      // 获取接口数据
      const interfaceData = await this.fetchInterfaceData(interfaceId);

      // 解析响应Schema
      const fullResSchema = this.parseJsonSchema(interfaceData.data.res_body);

      // 提取data字段的schema（实际业务数据结构）
      const resSchema = fullResSchema.properties?.data || fullResSchema;

      // 构建详细的提示词
      const prompt = this.buildGenerationPrompt(interfaceData, resSchema, generateType);

      // 生成结果
      const result: any = {
        interfaceId,
        projectId: String(interfaceData.data.project_id),
        interfaceName: interfaceData.data.title,
        method: interfaceData.data.method,
        path: interfaceData.data.path,
        schemas: {
          response: resSchema
        },
        prompt: prompt,
        shouldSaveFiles: CONFIG.SAVE_FILES,
        outputDir: CONFIG.OUTPUT_DIR
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `提取YAPI接口失败: ${error}`
      );
    }
  }

  private async handleSaveGeneratedFiles(args: any) {
    const { interfaceId, mockData, typeDefinitions } = args;

    try {
      await this.saveFilesToDisk(interfaceId, mockData, typeDefinitions);

      return {
        content: [
          {
            type: "text",
            text: `文件保存成功: ${interfaceId}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `保存文件失败: ${error}`
      );
    }
  }

  private async handleSaveAdvancedMock(args: any) {
    const { interfaceId, projectId, name, mockData } = args;

    try {
      // 确保已登录
      await this.loginToYapi();

      // 组装完整的响应体（添加 code 和 msg）
      const fullResBody = JSON.stringify({
        code: 200,
        msg: "",
        data: JSON.parse(mockData),
      }, null, 2);
      const now = new Date().getTime()
      const response = await axios.post(
        `${CONFIG.YAPI_BASE_URL}/api/plugin/advmock/case/save`,
        {
          name: name + now, // 避免同名冲突，添加时间戳
          interface_id: interfaceId,
          project_id: projectId,
          res_body: fullResBody,
          code: "200",
          delay: 0,
          headers: [],
          params: {},
          ip_enable: false,
        },
        {
          timeout: 10000,
          headers: {
            "Content-Type": "application/json",
            Cookie: this.cookies.join("; "),
          },
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        }
      );

      if (response.data.errcode !== 0) {
        throw new Error(response.data.errmsg);
      }

      return {
        content: [
          {
            type: "text",
            text: `高级Mock保存成功: ${name}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `保存高级Mock失败: ${error}`
      );
    }
  }

  private async saveFilesToDisk(interfaceId: string, mockData?: string, typeDefinitions?: string) {
    if (!CONFIG.OUTPUT_DIR) {
      throw new Error("OUTPUT_DIR environment variable is not set");
    }

    // 智能解析路径：绝对路径直接用，相对路径相对于项目根目录
    const baseDir = resolveOutputDir(CONFIG.OUTPUT_DIR);

    // 确保目录存在
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    // 保存mock数据
    if (mockData) {
      const mockFilePath = path.join(baseDir, `${interfaceId}-mock.json`);
      fs.writeFileSync(mockFilePath, JSON.stringify(JSON.parse(mockData), null, 2), "utf-8");
    }

    // 保存类型定义
    if (typeDefinitions) {
      const typesFilePath = path.join(baseDir, `${interfaceId}-types.ts`);
      fs.writeFileSync(typesFilePath, typeDefinitions, "utf-8");
    }
  }

  private buildGenerationPrompt(
    interfaceData: YapiInterfaceResponse,
    resSchema: JsonSchema,
    generateType: string
  ): string {
    let prompt = `基于YAPI接口"${interfaceData.data.title}"的JSON Schema信息，请生成以下内容：\n\n`;

    prompt += `接口信息：\n`;
    prompt += `- 接口名称：${interfaceData.data.title}\n`;
    prompt += `- 请求方法：${interfaceData.data.method}\n`;
    prompt += `- 接口路径：${interfaceData.data.path}\n\n`;

    // 添加响应Schema信息
    prompt += `响应数据结构：\n`;
    prompt += JSON.stringify(resSchema, null, 2) + '\n\n';

    // 根据generateType添加相应的生成要求
    if (generateType === "mock" || generateType === "both") {
      prompt += `请生成Mock数据：\n`;
      prompt += `- 基于响应Schema生成完整的JSON数据\n`;
      prompt += `- 对于字符串类型，根据description生成，如果和datetime相关，生成时间戳"\n`;
      prompt += `- 对于数字类型，生成合理的随机数值\n`;
      prompt += `- 对于数组类型，默认生成2个数组项\n`;
      prompt += `- 对于枚举类型，默认合理的枚举值\n`;
      prompt += `- 处理YAPI的mock语法：@timestamp生成时间戳，@pick([...])从数组中随机选择\n`;
      prompt += `- 确保生成的JSON数据完全符合Schema结构\n\n`;
    }

    if (generateType === "types" || generateType === "both") {
      prompt += `请生成TypeScript类型定义：\n`;
      prompt += `- 生成Response接口\n`;
      prompt += `- 使用export interface语法\n`;
      prompt += `- 为字段添加JSDoc注释（使用description）\n`;
      prompt += `- 正确处理所有字段\n`;
      prompt += `- 数组类型使用[]语法\n`;
      prompt += `- 枚举类型使用联合类型语法 "value1" | "value2"，如果类型过多（比如超出5个），可根据枚举备注单独定义enum type\n`;
      prompt += `- 所有类型定义放在一个字符串中，用\n\n分隔\n\n`;
    }

    prompt += `返回格式：\n`;
    if (generateType === "mock") {
      prompt += `- 只返回mockData字段，值为JSON字符串\n`;
    } else if (generateType === "types") {
      prompt += `- 只返回typeDefinitions字段，值为TypeScript代码字符串\n`;
    } else {
      prompt += `- 返回mockData和typeDefinitions字段\n`;
      prompt += `- mockData值为JSON字符串\n`;
      prompt += `- typeDefinitions值为TypeScript代码字符串\n`;
    }

    prompt += `数据返回以后，请对数据进行以下操作：\n`;

    // 文件保存指示
    if (CONFIG.SAVE_FILES) {
      prompt += `\n本地文件保存：\n`;
      prompt += `- 自动调用save_generated_files工具保存文件\n`;
    }

    // 高级Mock保存指示
    if (generateType === "mock" || generateType === "both") {
      prompt += `\nYAPI高级Mock保存：\n`;
      prompt += `- 自动调用save_advanced_mock工具将mock的json数据保存到YAPI\n`;
      prompt += `- 传入interfaceId、projectId、name（接口名称）、mockData（只传data部分的JSON字符串，不需要code和msg）\n`;
    }

    if (!CONFIG.SAVE_FILES && generateType === "types") {
      prompt += `\n【重要】不要询问任何问题\n`;
    }

    return prompt;
  }

  private setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error("MCP Server error:", error);
    };

    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("YAPI Extractor MCP Server running on stdio");
  }
}

// 启动服务器
const server = new YapiExtractorServer();
server.run().catch(console.error);
