"""Optional plugin packages: declarative metadata, never installation hooks."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

PluginId = Annotated[str, StringConstraints(pattern=r'^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', max_length=64)]
PluginVersion = Annotated[str, StringConstraints(pattern=r'^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$', max_length=64)]
Digest = Annotated[str, StringConstraints(pattern=r'^[a-f0-9]{64}$')]


class LocalizedPluginText(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, str_strip_whitespace=True)
    zh: str = Field(alias='zh-CN', min_length=1, max_length=500)
    en: str = Field(alias='en-US', min_length=1, max_length=500)


class PluginManifest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    schemaVersion: Literal[1]
    id: PluginId
    version: PluginVersion
    name: LocalizedPluginText
    description: LocalizedPluginText
    runtimes: list[str] = Field(min_length=1, max_length=6)
    dependencies: dict[PluginId, PluginVersion] = Field(default_factory=dict, max_length=32)


class InstalledPlugin(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    manifest: PluginManifest
    digest: Digest
    source: str
    enabledRuntimes: list[str] = Field(default_factory=list)


class PluginRegistryRecord(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    version: Literal[1] = 1
    plugins: dict[PluginId, InstalledPlugin] = Field(default_factory=dict)


PLUGIN_ERRORS = {
    'plugin_invalid': ('插件包无效：请检查清单、技能入口及文件格式。', 'Invalid plugin package. Check its manifest, skill entry and files.'),
    'plugin_unsafe_path': ('插件包不能包含链接、特殊文件或不安全的路径及文件名。', 'Plugin packages cannot contain links, special files or unsafe paths and filenames.'),
    'plugin_too_large': ('插件包超过文件数量或大小限制。', 'The plugin package exceeds the file count or size limit.'),
    'plugin_source_unavailable': ('无法读取插件来源，请检查文件路径或下载地址。', 'Cannot read the plugin source. Check the file path or download URL.'),
    'plugin_source_outside_workspace': ('本地插件必须位于后端工作目录内的独立文件夹，不能使用工程或内部数据目录；其他位置的插件请上传 ZIP 文件。', 'Local plugins must be inside the backend workspace, outside project and internal data directories. Upload a ZIP file to install from elsewhere.'),
    'plugin_url_unsafe': ('插件下载地址必须是公开 HTTPS 地址，且不能包含登录凭证。', 'Plugin downloads require a public HTTPS URL without embedded credentials.'),
    'plugin_registry_invalid': ('插件登记文件损坏或格式不受支持，原文件已保留。', 'The plugin registry is damaged or unsupported. The original file was preserved.'),
    'plugin_conflict': ('已安装不同内容的同名插件，请先停用并卸载旧包。', 'A different package with this plugin ID is installed. Disable and uninstall it first.'),
    'plugin_missing': ('插件尚未安装，请刷新插件列表。', 'This plugin is not installed. Refresh the plugin list.'),
    'plugin_changed': ('插件版本已经变化，请刷新后重试。', 'The installed plugin has changed. Refresh and try again.'),
    'plugin_runtime_unsupported': ('此插件不支持所选引擎。', 'This plugin does not support the selected harness.'),
    'plugin_dependency_missing': ('请先在此引擎安装并启用清单要求的依赖版本。', 'Install and enable the declared dependency versions for this harness first.'),
    'plugin_required': ('其他已启用插件依赖此插件，请先停用它们。', 'Other enabled plugins depend on this plugin. Disable them first.'),
    'plugin_skill_conflict': ('插件技能与已有技能重名或入口不匹配，请修正插件包。', 'The plugin skill conflicts with an existing skill or its entry does not match. Correct the package.'),
}
