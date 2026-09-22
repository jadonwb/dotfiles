// V2 plugin: registers the pdf_read and pdf_search tools.
// Tool implementations live in ./pdf.ts so they can be reviewed or replaced
// independently of the registration layer.
import { createPdfTools } from "./pdf.ts"

export default {
  id: "personal.pdf-tools",
  async setup(ctx) {
    // The location directory stands in for the V1 context.directory:
    // relative PDF paths resolve against the directory of each location
    // this global plugin is instantiated for.
    const directory = ctx.location.directory
    await ctx.tool.transform((editor) => {
      for (const tool of createPdfTools(directory)) editor.add(tool)
    })
  },
}
