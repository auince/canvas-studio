# Canvas Studio

**把 ComfyUI 从一张复杂的节点网，变成一间顺手的创作工作室。**

Canvas Studio 面向想把精力放在画面、而不是反复接线和排查参数上的创作者。它把提示词、参考图、模型、LoRA 和生成设置收进清晰的界面，再将选择编排成 ComfyUI 工作流；需要批量探索时，Random Studio 可以一次排队多组随机种子，逐张显示进度与结果，让“抽卡”变成可控、可重复的创作流程。

## 它解决什么问题

- **自动工作流编排**：根据界面中的模型、提示词、参考图和生成参数组装工作流，减少手工连接节点、改错节点以及图片与提示词错配的麻烦。
- **批量自动抽卡**：设定批次数量，由系统逐次生成并呈现进度和结果；随机种子便于探索变化，也便于复现满意的一张。
- **LoRA 与模型轻松配置**：从界面选择可用模型和 LoRA，调整 LoRA 强度及生成参数，不用每次钻进工作流节点里改数值。
- **提示词组合更直观**：将文本提示与参考图作为创作入口；Random Studio 还支持从提示词池和分组中挑选内容，组合成批量任务。
- **工作流模板入口**：Canvas Studio 提供模板页，便于浏览和使用部署侧提供的 ComfyUI 工作流模板。
- **结果管理各有侧重**：Canvas Studio 以浏览器端保存为主；Random Studio 提供服务端加密图库及网页预览、导出能力。部署时可按自己的保留策略配置。

```text
提示词 / 参考图 / 模型 / LoRA / 参数
                  │
                  ▼
          自动组装 ComfyUI 工作流
                  │
                  ▼
         排队生成 · 进度 · 结果管理
```

## 仓库结构

这是一个 monorepo：两个可独立运行的应用共用一个代码仓库，各自保留自己的服务端、静态前端和测试。

```text
.
├── apps/
│   ├── canvas-studio/    # 主创作界面：模型/LoRA 配置、生成、提示词与工作流模板
│   └── random-studio/    # 随机工坊：提示词组合、批量任务、进度与结果图库
├── .gitignore
└── README.md
```

## 快速开始

两个应用都需要一个可访问的 ComfyUI 服务，以及由你自行安装的模型、LoRA 和工作流资源。仓库只包含应用代码，不含模型权重、个人提示词库、私有工作流、生成图片、密钥或服务器部署配置。

### Canvas Studio

```bash
cd apps/canvas-studio
python -m pip install aiohttp safetensors
python app.py
```

默认网页地址为 `http://127.0.0.1:8189`，默认连接 `http://127.0.0.1:8188` 上的 ComfyUI。可通过环境变量设置 ComfyUI 地址、资源根目录、模型目录及输入/输出位置；变量列表和细节见 [Canvas Studio 说明](apps/canvas-studio/README.md)。

### Random Studio

```bash
cd apps/random-studio
python -m pip install -e ".[dev]"
python run.py
```

具体运行参数、ComfyUI 连接和资源目录说明见 [Random Studio 说明](apps/random-studio/README.md)。提示词目录、工作流图、模型/LoRA 清单、生成结果与加密密钥需要在部署环境中单独准备。

## 测试

Random Studio 的测试可在应用目录运行：

```bash
cd apps/random-studio
python -m pytest
```

Canvas Studio 的浏览器端和服务端测试脚本位于 `apps/canvas-studio/`。部分集成测试需要可用的 ComfyUI 实例或部署资源。

## 安全与数据边界

请勿把 API 密钥、SSH 凭据、模型权重、用户上传内容、提示词私库、生成图片或运行时密钥提交到 Git。应用的运行数据和部署设置由使用者在自己的环境中管理；公开仓库中的代码不会代替你配置或启动服务器。
