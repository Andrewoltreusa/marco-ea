// TEMP (deleted after run): append KB sections 17-24 to Monday doc 40608915.
// after_block_id must reference a TOP-LEVEL sibling — the doc is heavily
// nested, so we anchor on the top-level block with the highest position.
import { readFileSync } from "fs";

const DOC_ID = "40608915";
const API = "https://api.monday.com/v2";
const KEY = process.env.MONDAY_API_KEY!;

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: KEY,
      "Content-Type": "application/json",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors).slice(0, 500));
  return json.data!;
}

// 1. Find the top-level block with the highest position.
let topLevel: Array<{ id: string; position: number }> = [];
for (let page = 1; page < 100; page++) {
  const data = await gql<{
    docs: Array<{ blocks: Array<{ id: string; position: number; parent_block_id: string | null }> }>;
  }>(
    `query ($docId: [ID!], $page: Int!) { docs(ids: $docId) { blocks(page: $page, limit: 100) { id position parent_block_id } } }`,
    { docId: [DOC_ID], page },
  );
  const blocks = data.docs[0]?.blocks ?? [];
  topLevel.push(...blocks.filter((b) => !b.parent_block_id));
  if (blocks.length < 100) break;
}
topLevel.sort((a, b) => a.position - b.position);
const anchor = topLevel[topLevel.length - 1];
console.log(`top-level blocks: ${topLevel.length}; anchor: ${anchor.id} (pos ${anchor.position})`);

// 2. Split the additions into (type, text) blocks.
const src = readFileSync(
  "C:\\Users\\ANDREW~1\\AppData\\Local\\Temp\\claude\\c--Users-AndrewShpiruk-Oltre-Marco\\46a91dcf-88d7-47c5-a99c-192c88f37ad5\\scratchpad\\kb-additions.md",
  "utf-8",
);
const paragraphs = src
  .split(/\r?\n\s*\r?\n/)
  .map((p) => p.trim())
  .filter((p) => p.length > 0 && p !== "---");

const blocks: Array<{ type: string; text: string }> = [];
for (const p of paragraphs) {
  if (/^\d{2}\. /.test(p) && !p.includes("\n")) {
    blocks.push({ type: "medium_title", text: p });
  } else {
    blocks.push({ type: "normal_text", text: p });
  }
}
console.log("blocks to create:", blocks.length);

// 3. Chain-create as top-level siblings after the anchor.
let after = anchor.id;
let created = 0;
for (const b of blocks) {
  const data = await gql<{ create_doc_block: { id: string } }>(
    `mutation ($docId: ID!, $type: DocBlockContentType!, $after: String, $content: JSON!) {
       create_doc_block(doc_id: $docId, type: $type, after_block_id: $after, content: $content) { id }
     }`,
    {
      docId: DOC_ID,
      type: b.type,
      after,
      content: JSON.stringify({
        alignment: "left",
        direction: "ltr",
        deltaFormat: [{ insert: b.text }],
      }),
    },
  );
  after = data.create_doc_block.id;
  created++;
  if (created % 10 === 0) console.log(`created ${created}/${blocks.length}`);
}
console.log(`DONE: created ${created} blocks after ${anchor.id}`);
