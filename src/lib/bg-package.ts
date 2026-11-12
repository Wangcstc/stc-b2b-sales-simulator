/**
 * 背调资料包的「剥壳」——规则本身属于题库格式，放在题库工具包里（bank-kit/strip.ts），
 * 抽屉质检背调包时也用同一份。柜子这里只转出来，调用处不用改。
 */
export { stripAnswers } from '../../bank-kit/index';
