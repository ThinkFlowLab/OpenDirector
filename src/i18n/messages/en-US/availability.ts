export const availability = {
  "availability.reason.query_timeout":
    "The query timed out. Existing validation remains in use.",
  "availability.reason.query_busy":
    "Capability checks are busy. Refresh shortly.",
  "availability.reason.query_failed":
    "The capability query failed. Existing validation remains in use.",

  "availability.title": "Service capabilities",
  "availability.check": "Check service capabilities",
  "availability.checking": "Checking service capabilities…",
  "availability.autoCheck": "Automatically check service capabilities",
  "availability.autoHint":
    "Check when opening a relevant view or submitting a new task. Failed checks preserve manual configuration.",
  "availability.checkedAt": "Last checked: {time}",
  "availability.status.available": "Declared supported",
  "availability.status.unavailable": "Currently unavailable",
  "availability.status.unknown": "Not confirmed",
  "availability.reason.not_checked":
    "Not checked. Saved configuration remains usable.",
  "availability.reason.supported":
    "The service declares support for this request.",
  "availability.reason.operation_unsupported":
    "This model does not support this operation. Choose a suitable model.",
  "availability.reason.profile_unsupported":
    "This model does not support this input or output mode.",
  "availability.reason.operation_disabled":
    "This operation is disabled in the deployment.",
  "availability.reason.route_disabled":
    "The endpoint used by this adapter is disabled.",
  "availability.reason.output_unsupported":
    "The model does not declare the required output type.",
  "availability.reason.execution_paused":
    "Execution is paused. Resume the service and try again.",
  "availability.reason.observation_expired":
    "The observation has expired. Refresh it; submission will check again.",
  "availability.reason.connection_failed":
    "Could not connect. Existing configuration and validation remain in use.",
  "availability.reason.authentication_failed":
    "Service authentication failed. Check the connection credentials.",
  "availability.reason.protocol_unavailable":
    "The service has no recognized capabilities endpoint. Manual configuration remains available.",
  "availability.reason.invalid_response":
    "The capability response is invalid. Existing validation remains in use.",
  "availability.reason.unsupported_version":
    "The capability protocol version is not recognized. Existing validation remains in use.",
  "availability.reason.declaration_incomplete":
    "The declaration is incomplete. Existing validation remains in use.",
  "availability.reason.required_inputs_missing":
    "This request is missing inputs required by the model.",
  "availability.reason.input_contract_unknown":
    "The service requires an input this adapter cannot identify. Existing validation remains in use.",
  "availability.reason.model_not_declared":
    "The service has no declaration for this exact model name.",
  "availability.reason.operation_not_declared":
    "The service has no declaration for this operation.",
  "availability.reason.profile_not_declared":
    "The service has no declaration for this input mode.",
  "availability.reason.route_not_declared":
    "The service has no declaration for the endpoint used by this adapter.",
  "availability.reason.adapter_not_mapped":
    "This adapter continues to use its existing parameter rules.",
  "availability.reason.mixed_operations":
    "Individual operation states are shown below.",
  "availability.profile.text_response": "Text response",
  "availability.profile.image_response": "Image response through chat",
  "availability.profile.text_to_image": "Image generation",
  "availability.profile.image_to_image": "Image editing",
  "availability.profile.text_to_video": "Text to video",
  "availability.profile.image_to_video": "Image to video",
  "availability.profile.video_to_video": "Video transformation",
  "availability.profile.text_to_speech": "Speech synthesis",
  "availability.profile.lyrics_to_music": "Music from lyrics and style",
  "availability.profile.text_to_audio": "General audio generation",
  "availability.profile.other": "Other request mode",
} as const;
