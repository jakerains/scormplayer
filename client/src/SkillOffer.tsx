import { useEffect, useState } from "react";
import { api, copyText } from "./api";
import { Icon } from "./icons";

/**
 * Pins are most useful handed to a coding agent, and an agent does far better with the
 * scormplayer skill (how to read pins, find the source, resolve them). When no agent has it, or
 * the installed copy is behind this scormplayer, the pins panel says so and gives the one
 * terminal command that fixes it: `scormplayer skill`. The page installs nothing itself.
 * Hidden when the skill is current, or once dismissed (per version, so an update shows again).
 */

type Skill = Awaited<ReturnType<typeof api.skill>>;

export function useAgentSkill() {
  const [skill, setSkill] = useState<Skill | null>(null);
  useEffect(() => { api.skill().then(setSkill, () => {}); }, []);
  const key = `scormplayer:skill-offer-dismissed:${skill?.state}:${skill?.version}`;
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try { setDismissed(localStorage.getItem(key) === "1"); } catch { setDismissed(false); }
  }, [key]);
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(key, "1"); } catch { /* storage blocked */ }
  };
  const show = !dismissed && (skill?.state === "missing" || skill?.state === "outdated");
  return { skill, show, dismiss };
}

export function SkillCard({ offer }: { offer: ReturnType<typeof useAgentSkill> }) {
  const [copied, setCopied] = useState(false);
  if (!offer.show || !offer.skill) return null;
  const outdated = offer.skill.state === "outdated";
  return (
    <div className="sp-skill" role="note">
      <div className="sp-skill__text">
        <strong>{outdated ? "Your agent skill is out of date" : "Let your coding agent act on these pins"}</strong>
        <span>
          {outdated
            ? <>It's from {offer.skill.installedVersion ? `scormplayer ${offer.skill.installedVersion}` : "an older scormplayer"}; this is {offer.skill.version}. Update it from your terminal:</>
            : <>The scormplayer skill teaches agents like Claude Code and Codex to read your pins, find the source and resolve each one. Install it from your terminal:</>}
        </span>
      </div>
      <div className="sp-skill__command">
        <code>scormplayer skill</code>
        <button type="button" className="sp-button" onClick={() => void copyText("scormplayer skill").then(() => setCopied(true))}>
          <Icon name="copy" size={14} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <span className="sp-skill__alt">or press <kbd>s</kbd> in the scormplayer window in your terminal</span>
      <button type="button" className="sp-icon-button sp-skill__close" onClick={offer.dismiss} aria-label="Not now" title="Not now"><Icon name="close" size={15} /></button>
    </div>
  );
}
