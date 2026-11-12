# 参与贡献

谢谢愿意帮忙。提交代码前请先读完这一页。

## 贡献者协议（必须先签）

本项目是双授权（AGPL-3.0 + 商用授权，见 [`COMMERCIAL.md`](COMMERCIAL.md)）。要能继续另卖商用授权，项目里每一行代码的著作权都得归在同一处。
所以：**你的第一个 Pull Request 被合并之前，需要签一份贡献者协议（CLA）**，同意把贡献的著作权授权给王铖运营社（STC），并允许它以 AGPL-3.0 和商用授权两种方式分发。
没签协议的 Pull Request 不会被合并。问题反馈（Issue）不需要签。

## 提交前

```bash
npm run hooks:install   # 第一次：装提交前检查
npm run verify          # 测试 + 各项自检
npx tsc --noEmit        # 类型
```

- 每一次修改都要升版本号：`npm run version:bump -- <major|minor|patch> "一句话说明"`。
- 测试、注释、文档里的人名、公司名、单号**一律用虚构的**，不许从真实聊天里抄。
- 模块边界见 README 的「目录」与 `npm run check:boundaries`：`engine/` 不碰数据库和模型；`drawer/` 不认识柜子；柜子只通过公开入口用题库工具包和抽屉。
