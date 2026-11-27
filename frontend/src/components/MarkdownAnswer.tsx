import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownAnswerProps {
  content: string;
  onClickRef: (resultId: string) => void;
  isStreaming?: boolean;
}

/**
 * Convert [ref:res_xxx] citations (including backtick-wrapped `[ref:res_xxx]`) outside fenced
 * code blocks into markdown links using a dedicated `ref://` scheme handled by our anchor renderer.
 */
function preprocessCitations(md: string): string {
  if (!md) return "";
  // Split only by fenced code blocks first so we never rewrite multi-line code blocks,
  // while still upgrading both [ref:res_xxx] and `[ref:res_xxx]` in prose/tables into badges.
  const fencedSegments = md.split(/(```[\s\S]*?```)/g);
  return fencedSegments
    .map((fencedSeg, fIdx) => {
      if (fIdx % 2 === 1) return fencedSeg;
      // First convert inline-code wrapped `[ref:res_xxx]` directly into ref:// links
      const unwrapped = fencedSeg.replace(
        /`\[ref:(res_[a-zA-Z0-9_]+)\]`/g,
        "[$1](ref://$1)"
      );
      // Then split by remaining inline code spans so other code examples stay untouched
      const inlineSegments = unwrapped.split(/(`[^`\n]+`)/g);
      return inlineSegments
        .map((seg, idx) => {
          if (idx % 2 === 1) return seg;
          return seg.replace(/\[ref:(res_[a-zA-Z0-9_]+)\]/g, "[$1](ref://$1)");
        })
        .join("");
    })
    .join("");
}

export function MarkdownAnswer({ content, onClickRef, isStreaming = false }: MarkdownAnswerProps) {
  const prepared = preprocessCitations(content || "");

  return (
    <div className="dp-markdown min-w-0 space-y-2.5 break-words text-[13px] leading-relaxed text-slate-700">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith("ref://") ? url : url)}
        components={{
          h1: ({ children }) => (
            <h2 className="pt-2 text-[15px] font-bold tracking-tight text-slate-900">{children}</h2>
          ),
          h2: ({ children }) => (
            <h3 className="pt-2 text-sm font-bold tracking-tight text-slate-900">{children}</h3>
          ),
          h3: ({ children }) => (
            <h4 className="pt-1.5 text-[13.5px] font-semibold text-slate-900">{children}</h4>
          ),
          h4: ({ children }) => (
            <h5 className="pt-1 text-[13px] font-semibold text-slate-800">{children}</h5>
          ),
          p: ({ children }) => <p className="leading-relaxed text-slate-700">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 list-disc space-y-1 pl-5 text-slate-700">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-1 pl-5 text-slate-700">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5 marker:text-indigo-500">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-3 border-indigo-300 bg-indigo-50/40 py-1.5 pr-3 pl-3 text-xs text-slate-600">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-slate-200" />,
          strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
          a: ({ href, children }) => {
            if (href && href.startsWith("ref://")) {
              const rid = href.slice(6);
              return (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClickRef(rid);
                  }}
                  className="mx-0.5 inline-flex items-center rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200/90 transition hover:bg-indigo-100 hover:ring-indigo-300"
                  title={`点击定位并查看结果证据 ${rid}`}
                >
                  {rid}
                </button>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-500"
              >
                {children}
              </a>
            );
          },
          code: ({ className, children, ...props }) => {
            const isBlock = Boolean(className && className.includes("language-")) || String(children).includes("\n");
            if (isBlock) {
              return (
                <code className="font-mono text-[12px] leading-relaxed text-slate-100" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11.5px] text-slate-800"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-xl border border-slate-800 bg-[#0d1117] px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-slate-100 shadow-xs">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-2.5 max-w-full overflow-x-auto rounded-xl border border-slate-200/90 shadow-2xs">
              <table className="w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-slate-200 bg-slate-50/90 text-slate-700">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-slate-100 bg-white">{children}</tbody>,
          tr: ({ children }) => <tr className="transition hover:bg-slate-50/70">{children}</tr>,
          th: ({ children }) => (
            <th className="whitespace-nowrap px-3 py-2 text-[11.5px] font-semibold text-slate-700">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 align-top leading-relaxed break-words text-slate-700 first:whitespace-nowrap first:font-medium first:text-slate-900">
              {children}
            </td>
          ),
        }}
      >
        {prepared}
      </ReactMarkdown>
      {isStreaming && (
        <span className="inline-block h-3.5 w-1.5 animate-pulse rounded-xs bg-indigo-500 align-middle" />
      )}
    </div>
  );
}
