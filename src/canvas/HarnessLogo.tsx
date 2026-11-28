import codex from "@lobehub/icons-static-svg/icons/codex.svg?url";
import claude from "@lobehub/icons-static-svg/icons/claudecode.svg?url";
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg?url";
import jiuwenswarm from "../assets/harness-logos/jiuwenswarm.svg";
import pi from "../assets/harness-logos/pi.svg";
import { ModelLogo } from "./ModelLogo";
import "./model-logo.css";

const monochrome: Record<string, string> = { codex, claude, opencode, pi };

export function HarnessLogo({ harness }: { harness: string }) {
  if (harness === "deepseek") return <ModelLogo organization="deepseek-ai" />;
  if (harness === "jiuwenswarm")
    return <img className="cw-model-logo cw-brand-mono" src={jiuwenswarm} alt="" aria-hidden="true" />;
  const url = monochrome[harness];
  return url ? (
    <img className="cw-model-logo cw-brand-mono" src={url} alt="" aria-hidden="true" />
  ) : null;
}
