import { useCallback, useEffect, useState } from "react";
import { api, type CheckReport } from "./api";
import { Icon } from "./icons";
import { findingElement, scanAccessibility, type A11yReport, type A11yViolation } from "./a11y";

/**
 * Checks before an LMS sees the course: the package (read from its files by the server) and
 * the accessibility of the page on screen (axe-core, run in the course frame). Findings on the
 * page can be shown or turned into a pin.
 */
export function Checks({ frame, onShow, onPin, onCopy, onClose }: {
  frame: () => HTMLIFrameElement | null;
  onShow: (element: Element) => void;
  onPin: (element: Element, note: string) => void;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"package" | "a11y">("package");
  const [report, setReport] = useState<CheckReport | null>(null);
  const [packageError, setPackageError] = useState("");
  const [scan, setScan] = useState<A11yReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const runPackage = useCallback(() => {
    setPackageError("");
    api.check().then(setReport, (error) => setPackageError(error.message));
  }, []);
  useEffect(runPackage, [runPackage]);

  async function runScan() {
    setScanning(true);
    setScanError("");
    try { setScan(await scanAccessibility(frame())); setOpen(null); }
    catch (error) { setScanError(error instanceof Error ? error.message : String(error)); }
    finally { setScanning(false); }
  }

  const copy = () => {
    const lines = ["# Course checks", ""];
    if (report) {
      lines.push(`## Package (${report.counts.error} errors, ${report.counts.warning} warnings, ${report.counts.info} notes)`, "");
      for (const finding of report.findings) lines.push(`- **${finding.severity}** ${finding.message}${finding.examples?.length ? ` (${finding.examples.join(", ")})` : ""}`);
      lines.push("");
    }
    if (scan) {
      lines.push(`## Accessibility of ${scan.title || scan.url} (${scan.violations.length} rules failed)`, "");
      for (const violation of scan.violations) {
        lines.push(`- **${violation.impact ?? "minor"}** ${violation.help} (${violation.id}, ${violation.nodes.length} element${violation.nodes.length === 1 ? "" : "s"}) ${violation.helpUrl}`);
        for (const node of violation.nodes.slice(0, 5)) lines.push(`  - \`${node.selector}\`: ${node.summary.replace(/\n+/g, " ")}`);
      }
    }
    onCopy(`${lines.join("\n")}\n`);
  };

  const pinNote = (violation: A11yViolation, summary: string) =>
    `Accessibility (${violation.impact ?? "minor"}): ${violation.help}. ${summary.split("\n")[0]} [axe ${violation.id}: ${violation.helpUrl}]`;

  return (
    <aside className="sp-panel sp-inspector sp-checks" aria-label="Checks">
      <header>
        <div><strong>Checks</strong><span>Package files and page accessibility</span></div>
        <button type="button" className="sp-icon-button" onClick={onClose} aria-label="Close checks"><Icon name="close" /></button>
      </header>
      <div className="sp-inspector__tools">
        <div className="sp-segmented" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "package"} onClick={() => setTab("package")}>
            Package {report ? <em className={report.counts.error ? "is-bad" : ""}>{report.counts.error + report.counts.warning}</em> : null}
          </button>
          <button type="button" role="tab" aria-selected={tab === "a11y"} onClick={() => setTab("a11y")}>
            Accessibility {scan ? <em className={scan.violations.length ? "is-bad" : ""}>{scan.violations.length}</em> : null}
          </button>
        </div>
      </div>
      <div className="sp-inspector__subtools">
        <span>
          {tab === "package"
            ? report ? `${report.files} files · ${(report.bytes / 1024 / 1024).toFixed(1)} MB` : "Reading the package…"
            : scan ? `${scan.title || scan.url} · ${scan.passes} rules passed` : "Scans the page on screen"}
        </span>
        <span>
          {tab === "package"
            ? <button type="button" onClick={runPackage}><Icon name="reload" size={13} /> Re-check</button>
            : <button type="button" onClick={() => void runScan()} disabled={scanning}><Icon name="check" size={13} /> {scanning ? "Scanning…" : scan ? "Scan again" : "Scan this page"}</button>}
          <button type="button" onClick={copy} disabled={!report && !scan}><Icon name="copy" size={13} /> Copy</button>
        </span>
      </div>
      <div className="sp-inspector__body">
        {tab === "package" ? (
          packageError ? <p className="sp-empty">{packageError}</p>
            : !report ? <p className="sp-empty">Checking…</p>
              : report.findings.length ? (
                <ol className="sp-issues">
                  {report.findings.map((finding, index) => (
                    <li key={index} className={`is-${finding.severity}`}>
                      <span className="sp-issues__badge">{finding.severity === "error" ? "error" : finding.severity === "warning" ? "warn" : "note"}</span>
                      <span>{finding.message}</span>
                      {finding.examples?.length ? <span className="sp-issues__meta">{finding.examples.join(" · ")}</span> : null}
                    </li>
                  ))}
                </ol>
              ) : <p className="sp-empty">No package problems found.</p>
        ) : scanError ? <p className="sp-empty">{scanError}</p>
          : !scan ? (
            <p className="sp-empty">Check this page with axe-core's WCAG A/AA rules and best practices: contrast, names, labels, structure and more. Move through the course and scan each page; automated checks find about half of the issues, so test with a keyboard and a screen reader too.</p>
          ) : scan.violations.length ? (
            <ol className="sp-issues sp-a11y">
              {scan.violations.map((violation) => (
                <li key={violation.id} className={violation.impact === "minor" || violation.impact === "moderate" ? "is-warning" : ""}>
                  <span className="sp-issues__badge">{violation.impact ?? "minor"}</span>
                  <span>
                    <button type="button" className="sp-a11y__toggle" aria-expanded={open === violation.id} onClick={() => setOpen((current) => current === violation.id ? null : violation.id)}>
                      {violation.help} <em>{violation.nodes.length}</em>
                    </button>
                  </span>
                  <span className="sp-issues__meta"><a href={violation.helpUrl} target="_blank" rel="noreferrer">{violation.id}</a></span>
                  {open === violation.id ? (
                    <ul className="sp-a11y__nodes">
                      {violation.nodes.map((node, index) => {
                        const element = findingElement(frame(), node.selector);
                        return (
                          <li key={index}>
                            <code title={node.html}>{node.selector}</code>
                            <span>{node.summary}</span>
                            <span className="sp-a11y__actions">
                              <button type="button" disabled={!element} onClick={() => element && onShow(element)}>Show</button>
                              <button type="button" disabled={!element} onClick={() => element && onPin(element, pinNote(violation, node.summary))}><Icon name="pin" size={12} /> Pin</button>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : <p className="sp-empty">No automated accessibility problems on this page. Check it with a keyboard and a screen reader too.</p>}
      </div>
    </aside>
  );
}
