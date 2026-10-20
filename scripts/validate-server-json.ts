/** Validates server.json against the official MCP Registry schema referenced in its $schema. */
import { readFileSync } from "node:fs";
import AjvModule from "ajv";

// ajv ships CJS; under NodeNext the constructor lives on .default.
const Ajv = ((AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule) as unknown as new (
  opts: Record<string, unknown>,
) => import("ajv").default;

const sj = JSON.parse(readFileSync("server.json", "utf8"));
const schema = (await (await fetch(sj.$schema)).json()) as Record<string, unknown>;
const ref = schema.$ref as string;
delete schema.$schema;
delete schema.$ref;
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(schema, "root");
const v = ajv.getSchema("root" + ref)!;
if (v(sj)) console.log(`server.json is valid against ${sj.$schema}`);
else {
  console.error(JSON.stringify(v.errors, null, 2));
  process.exit(1);
}
