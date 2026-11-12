# 标准层（standards）

柜子（网站）和抽屉（题库加工流水线）共同遵守的方法论与契约。**这里只有数据和类型，没有业务逻辑，也不依赖项目里任何其他模块。**

| 文件 | 是什么 | 谁用 |
|---|---|---|
| `syllabus/syllabus-v3.json` | 考纲 v3：55 个题型，每型的考点、主考力、满分动作、典型失分、素材识别特征、暗牌设计要点 | 抽屉归型和出题、柜子出考卷和统计覆盖 |
| `syllabus/README.md` | 考纲的可读版，**由 JSON 生成，不要手改**（`npm run gen:syllabus-doc`） | 人 |
| `forces.json` | 七力 | 评分 |
| `redlines.json` | 四条红线 | 评分 |
| `quality-rules.json` | 出题质量门槛（暗牌张数、解锁条件条数、验证用例条数等） | 抽屉质检；对已有题库只提醒 |
| `schema/*.schema.json` | 题库格式 v1 的 JSON Schema：题目、产品、背调包、manifest、考纲覆盖、公司信息、产品目录 | 题库工具包校验 |
| `templates/raw-material-templates.json` | 原材料模板的列定义 | 生成 Excel 模板、抽屉解析模板 |
| `templates/*.xlsx` | 产品表模板、公司信息模板，**由 JSON 生成**（`npm run gen:templates`） | 客户 |
| `templates/投料说明.md` | 客户交什么、怎么填 | 客户 |
| `index.ts` | 给 TS 代码用的类型与读取函数 | 柜子、抽屉、题库工具包 |

## 规矩

- **JSON 是真源，文档和 Excel 都是生成物。** 改考纲只改 `syllabus-v3.json`，改模板列只改 `raw-material-templates.json`，然后重新生成。
- **改考纲须王老师拍板并升考纲版本**：新增、改名、合并、删除题型，调整主考力。
- **题库格式有变化要升 `format_version`**，并同步 `bank-kit/types.ts`。
