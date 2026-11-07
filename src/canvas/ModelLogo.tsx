import vllmLogo from "@lobehub/icons-static-svg/icons/vllm.svg?url";
import mossLogo from "../assets/provider-logos/moss.svg?url";
import { modelLogoUrls } from "./modelLogoUrls";
import { useState } from "react";
import { CanvasIcon } from "./CanvasIcon";
import { modelBrand } from "./modelBrands";
import "./model-logo.css";



export function ModelLogo({
  modelId = "",
  organization,
}: {
  modelId?: string;
  organization?: string;
}) {
  const brand = modelBrand(modelId, organization);
  const [failed, setFailed] = useState("");
  if (
    organization?.toLowerCase() === "openmoss-team" ||
    modelId.trim().split("/").at(-1)?.toLowerCase().startsWith("moss-")
  )
    return <img className="cw-model-logo" src={mossLogo} alt="" aria-hidden="true" title="MOSS" />;
  if (organization?.toLowerCase() === "vllm-project")
    return <img className="cw-model-logo cw-brand-mono" src={vllmLogo} alt="" aria-hidden="true" title="vLLM" />;
  if (!brand || failed === brand.file)
    return (
      <span className="cw-model-logo" aria-hidden="true">
        <CanvasIcon name="model" size={16} />
      </span>
    );
  return (
    <img
      className="cw-model-logo cw-brand-mono"
      src={modelLogoUrls[brand.file]}
      alt=""
      aria-hidden="true"
      title={brand.name}
      onError={() => setFailed(brand.file)}
    />
  );
}
