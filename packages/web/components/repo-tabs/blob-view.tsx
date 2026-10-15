/**
 * One file at a ref: highlighted lines with numbers you can link to (`#L12`), a Markdown file
 * rendered (its source one click away), and a plain word for binary or cut files.
 */
import { highlight, languageOf } from '../../src/code/highlight';
import type { CodeLocation } from './code-browser';
import type { FileBlob } from '../../src/repo-pages/engine-reads';
import { codeHref, readmeHref, sizeText } from '../../src/code/tree';
import { CodeLink } from './code-opener';
import { CodeTokens } from './code-tokens';
import { MarkdownView } from './markdown-view';
import styles from './repo-tabs.module.css';

export function BlobView(props: {
  readonly at: CodeLocation;
  readonly file: FileBlob;
  /** Show a Markdown file's source rather than rendering it. */
  readonly plain: boolean;
}) {
  const { at, file } = props;
  const isMarkdown = /\.(md|markdown)$/i.test(file.path);
  const lines = file.content === null ? 0 : file.content.replace(/\n$/, '').split('\n').length;
  const self = codeHref(at.base, 'blob', file.path, at.ref);
  return (
    <section className={styles.box} aria-label={file.path}>
      <div className={styles.boxHead}>
        <span className={styles.headTitle}>
          {file.content === null ? 'Binary file' : `${lines} lines`}, {sizeText(file.size)}
        </span>
        <span className={styles.headMeta}>
          {isMarkdown ? (
            <CodeLink
              href={props.plain ? self : `${self}${self.includes('?') ? '&' : '?'}plain=1`}
              to={{ view: 'blob', path: file.path, plain: !props.plain }}
            >
              {props.plain ? 'Rendered' : 'Source'}
            </CodeLink>
          ) : null}
          <span className={styles.mono}>{at.sha.slice(0, 7)}</span>
        </span>
      </div>
      <BlobBody at={at} file={file} plain={props.plain} isMarkdown={isMarkdown} />
      {file.truncated ? (
        <p className={styles.note}>
          The file is longer than shown here; clone the repository for all of it.
        </p>
      ) : null}
    </section>
  );
}

function BlobBody(props: {
  readonly at: CodeLocation;
  readonly file: FileBlob;
  readonly plain: boolean;
  readonly isMarkdown: boolean;
}) {
  const { file } = props;
  if (file.content === null)
    return (
      <p className={styles.note}>
        This file is binary, so it is not shown here. Clone the repository to open it.
      </p>
    );
  if (!props.isMarkdown || props.plain) return <CodeLines text={file.content} path={file.path} />;
  const folder = file.path.split('/').slice(0, -1).join('/');
  return (
    <MarkdownView
      text={file.content}
      resolve={(href) => readmeHref({ ...props.at, path: folder }, href)}
    />
  );
}

function CodeLines(props: { readonly text: string; readonly path: string }) {
  const lines = highlight(props.text, languageOf(props.path));
  return (
    <div className={styles.code}>
      <table>
        <tbody>
          {lines.map((tokens, index) => {
            const number = index + 1;
            return (
              <tr key={number} id={`L${number}`}>
                <td className={styles.lineNo}>
                  <a href={`#L${number}`}>{number}</a>
                </td>
                <td>
                  <CodeTokens tokens={tokens} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
