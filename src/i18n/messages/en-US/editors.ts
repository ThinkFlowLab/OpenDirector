/** English copy for the image, layer and stage editors. Keys match `zh-CN/editors.ts`. */
export const editors = {
  "editors.image.title": "Edit image",
  "editors.image.openLayers": "Layer studio",
  "editors.image.closeAria": "Close image editor",
  "editors.image.loading": "Reading local image…",
  "editors.image.emptyPreview": "No editable preview",
  "editors.image.previewAria": "Image preview after crop and color adjustments",
  "editors.image.freeCropAria":
    "Free crop area: drag to move, adjust the width and height from the bottom-right corner",
  "editors.image.originalSize": "Original {width} × {height}",
  "editors.image.localImage": "Local image",
  "editors.image.outputSize": "Output {width} × {height} · PNG",
  "editors.image.outputPng": "Output PNG",
  "editors.image.description":
    "The preview shows the actual crop area. Applying changes the image pixels on the canvas and can be undone there.",
  "editors.image.controlsAria": "Image editing settings",
  "editors.image.section.crop": "Crop and transform",
  "editors.image.resetAll": "Reset all",
  "editors.image.aspect": "Crop ratio",
  "editors.image.aspect.original": "Original ratio",
  "editors.image.aspect.free": "Free crop",
  "editors.image.rotate": "Rotate 90°",
  "editors.image.flipX": "Flip horizontally",
  "editors.image.flipY": "Flip vertically",
  "editors.image.freeWidth": "Crop width",
  "editors.image.freeHeight": "Crop height",
  "editors.image.zoom": "Crop zoom",
  "editors.image.positionX": "Horizontal position",
  "editors.image.positionY": "Vertical position",
  "editors.image.section.color": "Color adjustments",
  "editors.image.livePreview": "Live pixel preview",
  "editors.image.brightness": "Brightness",
  "editors.image.contrast": "Contrast",
  "editors.image.saturation": "Saturation",
  "editors.image.localNote": "All edits happen locally in your browser.",
  "editors.image.footerNote": "Lossless PNG export · Nothing uploaded",
  "editors.image.applying": "Applying…",
  "editors.image.apply": "Apply edits",
  "editors.image.error.noCanvas":
    "The browser could not create the image editing canvas.",
  "editors.image.error.noFilter":
    "This browser does not support Canvas2D image filters. Use a recent Brave or Chrome.",
  "editors.image.error.failed": "Image editing did not complete. Try again.",
  "editors.image.error.noLocalSource":
    "This image has no editable local media yet. Import an image first.",
  "editors.image.error.remoteSource":
    "The image editor only supports local media and never downloads remote images. Import the image file to the canvas first.",
  "editors.image.error.invalidSize":
    "The image has no valid dimensions and cannot be edited.",
  "editors.image.error.readFailed":
    "The image could not be read. The media may be missing or the format unsupported; import it again.",
  "editors.image.error.tooLarge":
    "The image is too large for this browser to export. Increase the crop zoom and try again.",
  "editors.image.error.notApplied":
    "The edit was not applied. The draft is kept; check the source and lock state.",
  "editors.image.error.applyFailed": "Could not apply the edit: {reason}",
  "editors.image.error.exportCropFailed":
    "Could not export the crop. Make the image smaller and try again.",

  "editors.layers.title": "Layer studio",
  "editors.layers.back": "Back to crop",
  "editors.layers.closeAria": "Close the layer studio",
  "editors.layers.toolbarAria": "Layer tools",
  "editors.layers.tool.moveTitle": "Select, move, and transform",
  "editors.layers.tool.move": "Select",
  "editors.layers.tool.eraseTitle": "Erase areas of the selected layer by hand",
  "editors.layers.tool.erase": "Mask erase",
  "editors.layers.tool.restoreTitle": "Restore pixels erased by the mask",
  "editors.layers.tool.restore": "Mask restore",
  "editors.layers.brush": "Brush",
  "editors.layers.brushAria": "Mask brush size",
  "editors.layers.undoAria": "Undo layer operation",
  "editors.layers.redoAria": "Redo layer operation",
  "editors.layers.addImage": "Add image",
  "editors.layers.addText": "Text",
  "editors.layers.addRectangle": "Color block",
  "editors.layers.defaultText": "Enter text",
  "editors.layers.defaultTextLayer": "Text layer",
  "editors.layers.defaultRectangleLayer": "Color block layer",
  "editors.layers.originalImage": "Original image",
  "editors.layers.canvasAria": "Layer editing canvas",
  "editors.layers.previewAria": "Layer composite preview",
  "editors.layers.loading": "Reading local layers…",
  "editors.layers.openFailed": "Could not open the layer document",
  "editors.layers.sizeAndCount": {
    one: "{width} × {height} · {count} layer",
    other: "{width} × {height} · {count} layers",
  },
  "editors.layers.zoomOut": "Zoom out the layer view",
  "editors.layers.fitView": "Fit view",
  "editors.layers.zoomIn": "Zoom in the layer view",
  "editors.layers.inspectorAria": "Layers and properties",
  "editors.layers.section.layers": "Layers",
  "editors.layers.section.layersHint": "Composited top to bottom",
  "editors.layers.hideLayer": "Hide layer {name}",
  "editors.layers.showLayer": "Show layer {name}",
  "editors.layers.maskStrokes": {
    one: "Mask · {count} stroke",
    other: "Mask · {count} strokes",
  },
  "editors.layers.kind.image": "Image",
  "editors.layers.kind.text": "Text",
  "editors.layers.kind.rectangle": "Color block",
  "editors.layers.lockLayer": "Lock layer {name}",
  "editors.layers.unlockLayer": "Unlock layer {name}",
  "editors.layers.emptyHint":
    "Add an image, text, or color block to start. You can also drop in local images.",
  "editors.layers.moveUpTitle": "Move up one layer",
  "editors.layers.moveUpAria": "Move layer up",
  "editors.layers.moveDownTitle": "Move down one layer",
  "editors.layers.moveDownAria": "Move layer down",
  "editors.layers.bringFrontTitle": "Bring to front",
  "editors.layers.bringFrontAria": "Bring layer to front",
  "editors.layers.sendBackTitle": "Send to back",
  "editors.layers.sendBackAria": "Send layer to back",
  "editors.layers.duplicate": "Duplicate layer",
  "editors.layers.delete": "Delete layer",
  "editors.layers.properties.title": "Layer properties",
  "editors.layers.properties.locked": "Locked",
  "editors.layers.properties.name": "Name",
  "editors.layers.properties.nameAria": "Layer name",
  "editors.layers.properties.opacity": "Opacity",
  "editors.layers.properties.opacityAria": "Layer opacity",
  "editors.layers.numericAria": "Layer {label}",
  "editors.layers.numeric.width": "Width",
  "editors.layers.numeric.height": "Height",
  "editors.layers.numeric.rotation": "Rotation",
  "editors.layers.transform.rotate": "Rotate 90°",
  "editors.layers.transform.flipX": "Flip horizontally",
  "editors.layers.transform.flipY": "Flip vertically",
  "editors.layers.transform.fit": "Fit to canvas",
  "editors.layers.text.content": "Text content",
  "editors.layers.text.contentAria": "Layer text content",
  "editors.layers.text.fontSize": "Font size",
  "editors.layers.text.fontSizeAria": "Text font size",
  "editors.layers.color": "Color",
  "editors.layers.colorAria": "Layer color",
  "editors.layers.mask.title": {
    one: "Hand-drawn mask · {count} stroke",
    other: "Hand-drawn mask · {count} strokes",
  },
  "editors.layers.mask.clear": "Clear mask",
  "editors.layers.mask.hint":
    "Erasing hides areas and restoring brings back original pixels. Every stroke is undoable; transparency is never filled with AI content.",
  "editors.layers.document.title": "Canvas",
  "editors.layers.document.width": "W",
  "editors.layers.document.widthAria": "Canvas width",
  "editors.layers.document.height": "H",
  "editors.layers.document.heightAria": "Canvas height",
  "editors.layers.document.resize": "Resize canvas",
  "editors.layers.document.resizeHint":
    "Only the bounds change; enlarging the canvas leaves transparent areas.",
  "editors.layers.document.background": "Background",
  "editors.layers.document.backgroundAria": "Layer canvas background",
  "editors.layers.document.transparent": "Transparent",
  "editors.layers.document.white": "White",
  "editors.layers.document.black": "Black",
  "editors.layers.ai.title": "AI layer separation, cutout, and outpainting",
  "editors.layers.ai.hint":
    "No real generation service is connected yet. Mask and layer edits here are done manually.",
  "editors.layers.notice.close": "Dismiss notice",
  "editors.layers.openFile": "Open layer file",
  "editors.layers.saveFile": "Save layer file",
  "editors.layers.fileHint":
    "Layer files keep editable content; applying composes a PNG.",
  "editors.layers.exportPng": "Export PNG",
  "editors.layers.processing": "Processing…",
  "editors.layers.apply": "Apply to canvas",
  "editors.layers.defaultName": "Layer",
  "editors.layers.defaultComposite": "Layer composite",
  "editors.layers.duplicateSuffix": "{name} copy",
  "editors.layers.error.fileTooLarge64":
    "A single asset can be at most 64 MB. Make the file smaller first.",
  "editors.layers.error.readFile": "The file could not be read.",
  "editors.layers.error.fileReadFailed": "Reading the file failed.",
  "editors.layers.error.maxLayers": {
    one: "The local editor supports up to {count} layer.",
    other: "The local editor supports up to {count} layers.",
  },
  "editors.layers.error.notImage": "“{name}” is not an image.",
  "editors.layers.notice.selectMaskLayer":
    "Select a visible, unlocked layer first. The mask only applies to that layer.",
  "editors.layers.notice.exportedJson":
    "Exported the editable layer file (with media and masks).",
  "editors.layers.error.pngTooLarge":
    "PNG export failed. Make the canvas smaller and try again.",
  "editors.layers.error.notApplied":
    "The edit was not applied. The layer draft is kept; check the source and lock state.",
  "editors.layers.error.pngFailed": "PNG export failed.",
  "editors.layers.notice.exportedPng": "Exported a {width} × {height} PNG.",
  "editors.layers.error.fileTooLarge128":
    "The layer file exceeds 128 MB. Use smaller media.",
  "editors.layers.notice.openedJson": "Opened the editable layer file.",

  "editors.stage.label.motionClip": "Motion clip",
  "editors.stage.label.shot": "Shot",
  "editors.stage.defaultCameraName": "Camera 1",
  "editors.stage.defaultPersonName": "Person 1",
  "editors.stage.error.invalidTransform":
    "The stage object position, rotation, or scale is invalid.",
  "editors.stage.error.invalidCamera":
    "The camera position, target, or field of view is invalid.",
  "editors.stage.error.invalidKeyframes": "The keyframe list is invalid.",
  "editors.stage.error.invalidKeyframeTime":
    "A keyframe ID or time is invalid; keyframe times cannot repeat.",
  "editors.stage.error.intervalInvalid":
    "{label} ID or interval is invalid and cannot exceed the stage duration.",
  "editors.stage.error.intervalOverlap": "{label} intervals cannot overlap.",
  "editors.stage.error.invalidLegacy": "The legacy stage document is invalid.",
  "editors.stage.error.invalidLegacyKeyframe":
    "A legacy stage keyframe is invalid.",
  "editors.stage.error.missingObject":
    "A keyframe references a missing or duplicate stage object.",
  "editors.stage.error.invalidLegacyObject": "A legacy stage object is invalid.",
  "editors.stage.error.jointMotionPerson": "Only people support joint motion.",
  "editors.stage.error.importedSceneMotion":
    "Scene assets cannot carry character motion clips.",
  "editors.stage.error.importedMotionUnavailable":
    "This imported character has no animation data.",
  "editors.stage.error.invalidDocument":
    "The local director preview format is invalid.",
  "editors.stage.error.invalidObject":
    "A stage object ID, type, or color is invalid.",
  "editors.stage.error.invalidMotionClip": "The motion clip is invalid.",
  "editors.stage.error.invalidCameraId": "The camera ID is invalid.",
  "editors.stage.error.cameraRequired":
    "Keep at least one camera; the active camera must exist.",
  "editors.stage.error.shotCamera":
    "A shot references a camera that does not exist.",
  "editors.stage.error.cameraMissing": "The camera does not exist.",

  "editors.layerDocument.defaultName": "Original image",
  "editors.layerDocument.error.size":
    "A local layer canvas allows at most 8192 pixels per side and 16.77 million pixels total. Make the image smaller first.",
  "editors.layerDocument.error.notJson": "The selected file is not a JSON document.",
  "editors.layerDocument.error.structure": "The layer file structure is invalid.",
  "editors.layerDocument.error.invalidParameter":
    "The layer file contains invalid dimensions, coordinates, or parameters.",
  "editors.layerDocument.error.invalidText":
    "The layer file contains invalid text.",
  "editors.layerDocument.error.invalidColor":
    "Layer colors must be six-digit hexadecimal values.",
  "editors.layerDocument.error.invalidBoolean":
    "The layer file contains an invalid switch.",
  "editors.layerDocument.error.unsupported":
    "This is not a supported OpenDirector layer file.",
  "editors.layerDocument.error.tooManyLayers": {
    one: "A layer file can contain at most {count} layer.",
    other: "A layer file can contain at most {count} layers.",
  },
  "editors.layerDocument.error.emptyId": "A layer ID is empty or duplicated.",
  "editors.layerDocument.error.remoteImage":
    "Layer images must be embedded in the file or come from this app; remote resources are never requested.",
  "editors.layerDocument.error.unsupportedKind":
    "The layer file contains an unsupported layer type.",
  "editors.layerDocument.error.maskTooLarge":
    "The layer mask data is too large or invalid.",
  "editors.layerDocument.error.invalidStroke": "A layer mask stroke is invalid.",
  "editors.layerDocument.error.tooManyPoints":
    "The mask exceeds the local editor point limit.",

  "editors.imageCrop.error.invalidDocument": "The image edit document is invalid.",
  "editors.imageCrop.error.invalidSource":
    "The image edit source or parameters are invalid.",
  "editors.imageCrop.error.outOfRange": "An image edit parameter is out of range.",

  "editors.videoCrop.error.rect":
    "The crop rectangle must stay inside the source video pixels, with positive integer width and height.",
  "editors.videoCrop.error.ratio": "The aspect ratio is invalid.",

  "editors.modal.apply": "Apply edits",
  "editors.modal.closeAria": "Close editor",
  "editors.modal.resourceUnavailable": "Media source unavailable",
  "editors.modal.addResource": "Add media",

  "editors.commit.notSaved": "The edit was not saved. The draft is kept.",
  "editors.commit.failed": "Saving the edit failed. The draft is kept.",

  "editors.media.error.aborted": "Reading the media was cancelled.",
  "editors.media.error.textTooLarge": "Text files must be at most 1 MiB.",
  "editors.media.error.textBinary":
    "The text file contains invalid binary content.",
  "editors.media.error.readFile": "Could not read {name}",
  "editors.media.error.missingSource":
    "The media has no readable source, so metadata cannot be read.",
  "editors.media.error.invalidDuration": "Could not read a valid media duration.",
  "editors.media.error.invalidSize":
    "Could not read valid media pixel dimensions.",
  "editors.media.error.timeout":
    "Reading media metadata timed out. Check the format or import it again.",
  "editors.media.error.seekEnd":
    "Could not seek to the end of the media to read its actual duration.",
  "editors.media.error.metadata": "Could not read metadata for “{title}”.",

  "editors.stage.ui.objectPerson": "Person",
  "editors.stage.ui.objectBox": "Box",
  "editors.stage.ui.objectSphere": "Sphere",
  "editors.stage.ui.objectGltf": "Imported model",
  "editors.stage.ui.importAsset": "Import GLB / GLTF",
  "editors.stage.ui.assetRole": "Imported asset role",
  "editors.stage.ui.assetCharacter": "Character",
  "editors.stage.ui.assetScene": "Scene",
  "editors.stage.ui.assetNotice":
    "This character has no animation data; it still follows camera, storyboard, and transform keyframes.",
  "editors.stage.ui.assetUnavailable":
    "The imported asset is unavailable. Reopen the project or import it again.",
  "editors.stage.ui.assetLoadFailed":
    "Could not load “{name}”. The file may be corrupt or reference external resources.",
  "editors.stage.ui.assetCorrupt":
    "Could not read “{name}”: the GLB header is valid but the embedded JSON is missing or corrupt.",
  "editors.stage.ui.assetTooLarge":
    "“{name}” is larger than {size} MB. Use a smaller GLB or GLTF file.",
  "editors.stage.ui.assetUnsupported":
    "Only GLB and self-contained GLTF files are supported. FBX and external GLTF resources are not supported yet.",
  "editors.stage.ui.assetCompressed":
    "Compressed models (Draco, meshopt, or KTX2) are not supported yet. Export the model uncompressed and import it again.",
  "editors.stage.ui.assetImported":
    "Imported {name} · {animationCount} animation clips",
  "editors.stage.ui.assetImportedStatic": "Imported {name} · no animation data",
  "editors.stage.ui.degreesSuffix": " (degrees)",
  "editors.stage.ui.editFailed": "The stage change failed.",
  "editors.stage.ui.cameraName": "Camera {number}",
  "editors.stage.ui.keepCamera": "Keep at least one camera.",
  "editors.stage.ui.cameraInUse":
    "A shot still uses this camera. Replace or delete that shot first.",
  "editors.stage.ui.webglInit": "WebGL could not start: {reason}",
  "editors.stage.ui.webglLost":
    "The WebGL context was lost. Save the stage data, reopen the editor, and continue.",
  "editors.stage.ui.rendererNotReady": "The stage renderer is not ready yet.",
  "editors.stage.ui.screenshotFailed": "The screenshot failed.",
  "editors.stage.ui.importFailed": "The stage could not be imported.",
  "editors.stage.ui.importNotJson":
    "The selected file is not a stage JSON document. Model files are imported with “Import GLB / GLTF”.",
  "editors.stage.ui.importForeignAssets":
    "The stage file pins imported models that are not registered in this project: {names}. Open the stage in its original project, or import the model files here first.",
  "editors.stage.ui.exportUnsavedImports":
    "The stage file cannot carry imported models that exist only in this browser: {names}. Apply edits to save them to the project first.",
  "editors.stage.ui.exportFailed": "The preview video export failed.",
  "editors.stage.ui.motionTitle": "{title} · Motion preview",
  "editors.stage.ui.addCanvasFailed": "Adding to the canvas failed.",
  "editors.stage.ui.title": "Director preview · {title}",
  "editors.stage.ui.subtitle":
    "Local 3D stage · camera and subject keyframes",
  "editors.stage.ui.undo": "Undo",
  "editors.stage.ui.redo": "Redo",
  "editors.stage.ui.importJson": "Import stage JSON",
  "editors.stage.ui.exportJson": "Export stage JSON",
  "editors.stage.ui.screenshot": "Capture camera still",
  "editors.stage.ui.stillCaptured":
    "Still captured. Applying registers it as a project image asset.",
  "editors.stage.ui.renderMp4": "Render preview MP4",
  "editors.stage.ui.renderProgress": "Rendering preview {percent}%",
  "editors.stage.ui.cancelRender": "Cancel rendering",
  "editors.stage.ui.renderDone":
    "Preview MP4 complete · {width}×{height} · 30 fps",
  "editors.stage.ui.downloadMp4": "Download preview MP4",
  "editors.stage.ui.addedToCanvas": "Added to canvas",
  "editors.stage.ui.addToCanvas": "Add preview video to canvas",
  "editors.stage.ui.sceneObjects": "Scene subjects",
  "editors.stage.ui.background": "Background color",
  "editors.stage.ui.grid": "Show ground grid",
  "editors.stage.ui.orbitHint": "Left-drag orbit · right-drag pan · wheel zoom",
  "editors.stage.ui.selectHint":
    "Click a subject to select it, then adjust its transform on the right.",
  "editors.stage.ui.stageAria": "Interactive 3D director stage",
  "editors.stage.ui.pause": "Pause",
  "editors.stage.ui.playAction": "Play motion and keyframes",
  "editors.stage.ui.currentTime": "Current time",
  "editors.stage.ui.currentTimeAria": "Stage current time",
  "editors.stage.ui.totalDuration": "Total duration",
  "editors.stage.ui.stageDurationAria": "Stage duration",
  "editors.stage.ui.recordKeyframe": "Record a keyframe here",
  "editors.stage.ui.playheadAria": "Stage playhead",
  "editors.stage.ui.deleteKeyframe": "Delete keyframe at {frame} s",
  "editors.stage.ui.keyframeHint":
    "Adjust the camera or subject at the start and end, then record keyframes to preview.",
  "editors.stage.ui.storyboard": "Shot track",
  "editors.stage.ui.addShot": "Add current camera at playhead",
  "editors.stage.ui.shotHint":
    "Shots cannot overlap; gaps use the current camera. Switch “Storyboard cuts” to preview and export the same shot sequence.",
  "editors.stage.ui.shot": "Shot {number}",
  "editors.stage.ui.shotCameraAria": "Shot {number} camera",
  "editors.stage.ui.shotStartAria": "Shot {number} start",
  "editors.stage.ui.shotDurationAria": "Shot {number} duration",
  "editors.stage.ui.locate": "Locate",
  "editors.stage.ui.deleteShot": "Delete shot {number}",
  "editors.stage.ui.transform": "Subject transform",
  "editors.stage.ui.camera": "Camera",
  "editors.stage.ui.name": "Name",
  "editors.stage.ui.material": "Material color",
  "editors.stage.ui.motionClips": "Character motion clips",
  "editors.stage.ui.addMotion": "Add motion at playhead",
  "editors.stage.ui.motionHint":
    "Clips for one character cannot overlap; gaps keep the character standing, and motion starts at the clip start.",
  "editors.stage.ui.motion": "Motion {number}",
  "editors.stage.ui.motionAria": "Motion {number}",
  "editors.stage.ui.motionStartAria": "Motion {number} start",
  "editors.stage.ui.motionDurationAria": "Motion {number} duration",
  "editors.stage.ui.motionSpeedAria": "Motion {number} speed",
  "editors.stage.ui.motionAmplitudeAria": "Motion {number} amplitude",
  "editors.stage.ui.speed": "Speed",
  "editors.stage.ui.amplitude": "Amplitude",
  "editors.stage.ui.deleteMotion": "Delete motion {number}",
  "editors.stage.ui.position": "Position",
  "editors.stage.ui.rotation": "Rotation",
  "editors.stage.ui.scale": "Scale",
  "editors.stage.ui.deleteObject": "Delete this subject",
  "editors.stage.ui.cameraLabel": "Camera ·",
  "editors.stage.ui.editCamera": "Edit camera",
  "editors.stage.ui.cameraNameAria": "Camera name",
  "editors.stage.ui.copyCamera": "Duplicate as new camera",
  "editors.stage.ui.deleteCamera": "Delete current camera",
  "editors.stage.ui.outputAspect": "Output aspect",
  "editors.stage.ui.outputAspectAria": "Director output aspect",
  "editors.stage.ui.source": "Preview and export source",
  "editors.stage.ui.sourceAria": "Director shot source",
  "editors.stage.ui.currentCamera": "Current camera, full duration",
  "editors.stage.ui.storyboardCut": "Storyboard cuts",
  "editors.stage.ui.cameraShort": "Camera",
  "editors.stage.ui.target": "Target",
  "editors.stage.ui.focal": "Focal length (35mm film, 16:9 equivalent)",
  "editors.stage.ui.verticalFov": "Vertical field of view {value}°",
  "editors.stage.ui.resetCamera": "Reset camera",
  "editors.stage.ui.footerHint":
    "Editing the camera or a subject writes a keyframe at the current time; preview, stills, and MP4 share the aspect and sampling. GLB and self-contained GLTF characters or scene assets are registered in the project and follow camera, storyboard, and transform keyframes. FBX and external GLTF resources are not supported yet.",
  "editors.stage.ui.importAria": "Import director stage",
  "editors.stage.ui.startSeconds": "Start (s)",
  "editors.stage.ui.durationSeconds": "Duration (s)",
  "editors.stage.ui.previewSuffix": "preview",
} as const;
