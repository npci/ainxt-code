// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = extractText(children);
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="codeblock">
      <button className="copy" onClick={copy}>{copied ? "copied" : "copy"}</button>
      <pre>{children}</pre>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre(props) {
            const { children } = props;
            return <CodeBlock>{children}</CodeBlock>;
          },
          a(props) {
            const { children, href } = props;
            // `noopener` is stated explicitly alongside `noreferrer`: current
            // browsers imply it, older ones do not, and the opened page must
            // never get a handle on this window via `window.opener` (CWE-1022).
            // href is string | undefined in react-markdown v10; fall back to "#".
            return (
              <a href={href ?? "#"} target="_blank" rel="noopener noreferrer">{children}</a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
