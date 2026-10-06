// migration の SQL 本体をそのまま読む（vite の `?raw`）。test/seriesNameDisplay.test.ts は
// db/fix-series-name-display-variants.sql を読んで流し、SQL そのものを仕様として確かめている。
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
