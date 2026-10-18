"""Extension metadata, release, and update status schemas in Pydantic v2."""

from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional
from pydantic import BaseModel, Field, ConfigDict


class ExtensionDistributionChannel(BaseModel):
    """Distribution channel metadata for extension builds."""
    model_config = ConfigDict(extra="forbid")

    channel: str = Field(..., description="Channel identifier, e.g. chrome_web_store, direct_crx")
    label: str = Field(..., description="Human-readable channel title")
    url: str = Field(..., description="Relative or absolute download URL")
    format: str = Field(..., description="Package format: zip or crx")


class ExtensionReleaseMeta(BaseModel):
    """Metadata describing a published extension release."""
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., description="Extension display name")
    version: str = Field(..., min_length=1, description="SemVer extension release version")
    extension_id: Optional[str] = Field(None, description="Deterministic 32-char extension ID")
    filename: str = Field(..., description="Filename of store-ready zip")
    versioned_filename: Optional[str] = Field(None, description="Filename of versioned zip archive")
    download_url: str = Field(..., description="Relative or absolute download URL for zip")
    crx_filename: Optional[str] = Field(None, description="Filename of signed crx package")
    crx_download_url: Optional[str] = Field(None, description="Relative or absolute URL for crx")
    updates_url: Optional[str] = Field(None, description="Chromium autoupdate protocol XML URL")
    sha256: str = Field(..., description="SHA-256 hash of zip package")
    size_bytes: int = Field(..., ge=0, description="Size of zip package in bytes")
    size_formatted: Optional[str] = Field(None, description="Human readable zip file size")
    crx_sha256: Optional[str] = Field(None, description="SHA-256 hash of crx package")
    crx_size_bytes: Optional[int] = Field(None, ge=0, description="Size of crx package in bytes")
    crx_size_formatted: Optional[str] = Field(None, description="Human readable crx file size")
    webstore_filename: Optional[str] = Field(None, description="Filename of Chrome Web Store zip (no key / update_url)")
    webstore_download_url: Optional[str] = Field(None, description="Relative or absolute URL for Chrome Web Store zip")
    built_at: Optional[str] = Field(None, description="ISO timestamp when package was built")
    manifest_version: Optional[int] = Field(3, description="Manifest specification version")
    supported_browsers: Optional[List[str]] = Field(default_factory=list)
    changelog: Optional[List[str]] = Field(default_factory=list)
    distribution_channels: Optional[List[ExtensionDistributionChannel]] = Field(default_factory=list)


class ExtensionUpdateCheckMethod(str, Enum):
    API_POLL = "API_POLL"
    NATIVE_RUNTIME = "NATIVE_RUNTIME"
    MANUAL_CHECK = "MANUAL_CHECK"
    OFFLINE_CACHE = "OFFLINE_CACHE"


class ExtensionUpdateChannel(str, Enum):
    NATIVE = "NATIVE"
    MANUAL_CRX = "MANUAL_CRX"
    MANUAL_UNPACKED = "MANUAL_UNPACKED"


class ExtensionUpdateStatus(BaseModel):
    """Status of extension self-update check."""
    model_config = ConfigDict(extra="forbid")

    currentVersion: str
    latestVersion: str
    updateAvailable: bool
    lastChecked: datetime
    checkMethod: ExtensionUpdateCheckMethod
    backendReachable: bool
    releaseMeta: Optional[ExtensionReleaseMeta] = None
    statusMessage: Optional[str] = None
    installPromptShown: bool = False
    updateChannel: Optional[ExtensionUpdateChannel] = None
    nativeUpdateReady: bool = False


class ExtensionVersionItem(BaseModel):
    """Metadata summary of a specific packaged extension version."""
    model_config = ConfigDict(extra="forbid")

    version: str
    is_latest: bool = False
    crx_download_url: Optional[str] = None
    zip_download_url: Optional[str] = None
    sha256: Optional[str] = None
    crx_sha256: Optional[str] = None
    built_at: Optional[str] = None


class ExtensionVersionsList(BaseModel):
    """List of available extension versions available for install/downgrade."""
    model_config = ConfigDict(extra="forbid")

    versions: List[ExtensionVersionItem]
    latest: Optional[str] = None


class WarningPresentationType(str, Enum):
    SMART = "smart"
    OVERLAY = "overlay"
    BANNER = "banner"
    NOTIFICATION = "notification"


class ExtensionWarningConfig(BaseModel):
    """Configuration for threat warning presentation and snooze/acknowledgment."""
    model_config = ConfigDict(extra="forbid")

    warningType: WarningPresentationType = WarningPresentationType.SMART
    snoozeDurationMinutes: int = 15
    snoozedDomains: Dict[str, int] = Field(default_factory=dict)
    acknowledgedDomains: Dict[str, int] = Field(default_factory=dict)

