import React, { memo, useMemo } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
for (const [name, language] of Object.entries({
  typescript,
  javascript,
  json,
  bash,
  python,
  css,
  xml,
  markdown,
  yaml,
  sql,
}))
  hljs.registerLanguage(name, language);
const languages: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  sh: "bash",
  zsh: "bash",
  py: "python",
  css: "css",
  html: "xml",
  svg: "xml",
  xml: "xml",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
};

/** Only escaped HTML produced by the registered highlighter reaches the markup sink. */
export const CodePreview = memo(function CodePreview({
  content,
  path,
}: {
  content: string;
  path: string;
}): React.JSX.Element {
  const language = languages[path.split(".").at(-1)?.toLowerCase() ?? ""];
  const highlighted = useMemo(
    () =>
      language && content.length <= 100_000
        ? hljs.highlight(content, { language, ignoreIllegals: true }).value
        : undefined,
    [content, language],
  );
  return (
    <pre className="file-preview">
      <code
        className="hljs"
        {...(highlighted === undefined ? {} : { dangerouslySetInnerHTML: { __html: highlighted } })}
      >
        {highlighted === undefined ? content || "(empty file)" : undefined}
      </code>
    </pre>
  );
});
