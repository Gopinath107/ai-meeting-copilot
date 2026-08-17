import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * AI output is untrusted. Only links that explicitly target a normal web or
 * email URL may leave the Electron renderer; relative paths, file URLs and
 * custom protocols are deliberately blocked.
 */
export function safeExternalHref(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Renders the AI answer as formatted Markdown so coding answers show real code
 * blocks and lists show as proper bullet/numbered points instead of one mixed
 * paragraph. Styling is tuned to be compact and readable inside the overlay.
 */
const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-2 list-disc space-y-1 pl-4 last:mb-0 marker:text-indigo-300">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-1 pl-4 last:mb-0 marker:text-indigo-300">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-snug">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  h1: ({ children }) => (
    <h3 className="mb-1 mt-2 text-[13px] font-semibold text-indigo-200 first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mb-1 mt-2 text-[13px] font-semibold text-indigo-200 first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2 text-[13px] font-semibold text-indigo-200 first:mt-0">{children}</h3>
  ),
  a: ({ children, href }) => {
    const safeHref = safeExternalHref(href)
    return safeHref ? (
      <a
        href={safeHref}
        className="text-indigo-300 underline"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ) : (
      <span className="text-zinc-300" title="Unsafe link blocked">
        {children}
      </span>
    )
  },
  img: ({ alt }) => (
    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-zinc-400">
      [Remote image blocked{alt ? `: ${alt}` : ''}]
    </span>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-indigo-400/40 pl-2 text-zinc-300 last:mb-0">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-2.5 last:mb-0">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const text = String(children ?? '')
    // react-markdown v9 has no `inline` prop: treat fenced (has language) or
    // multi-line content as a block, everything else as inline code.
    const isBlock = /language-(\w+)/.test(className ?? '') || text.includes('\n')
    if (isBlock) {
      return (
        <code className={`block font-mono text-[12px] leading-relaxed text-emerald-100 ${className ?? ''}`}>
          {children}
        </code>
      )
    }
    return (
      <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11.5px] text-emerald-200">
        {children}
      </code>
    )
  }
}

function MarkdownImpl({ children }: { children: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
      skipHtml
      urlTransform={(url) => safeExternalHref(url) ?? ''}
    >
      {children}
    </ReactMarkdown>
  )
}

export const Markdown = memo(MarkdownImpl)
