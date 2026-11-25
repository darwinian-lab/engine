import fs from "node:fs";
// Workers import .html files as text (wrangler's default module rules); do the same in tests.
export default {
  plugins: [
    {
      name: "html-as-text",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".html")) return `export default ${JSON.stringify(fs.readFileSync(id, "utf8"))};`;
      },
    },
  ],
};
