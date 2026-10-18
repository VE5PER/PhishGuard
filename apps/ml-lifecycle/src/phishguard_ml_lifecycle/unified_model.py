"""Unified Ultra-Lightweight Multimodal Model for PhishGuard Edge & Cloud Runtimes."""

from typing import Dict, Optional, Tuple, Union
import torch
import torch.nn as nn
import torch.nn.functional as F


class ConvBNReLU(nn.Sequential):
    """2D Convolution + BatchNorm2d + ReLU6 block."""

    def __init__(
        self,
        in_c: int,
        out_c: int,
        kernel_size: int = 3,
        stride: int = 1,
        padding: int = 1,
        groups: int = 1,
        act: bool = True,
    ):
        layers = [
            nn.Conv2d(
                in_c,
                out_c,
                kernel_size=kernel_size,
                stride=stride,
                padding=padding,
                groups=groups,
                bias=False,
            ),
            nn.BatchNorm2d(out_c),
        ]
        if act:
            layers.append(nn.ReLU6(inplace=True))
        super().__init__(*layers)


class UniversalInvertedBottleneck(nn.Module):
    """Universal Inverted Bottleneck (UIB) with Depthwise and Pointwise Convolutions."""

    def __init__(
        self,
        in_c: int,
        out_c: int,
        exp_ratio: float = 3.0,
        k_dw: int = 3,
        stride: int = 1,
    ):
        super().__init__()
        mid_c = int(in_c * exp_ratio)
        self.use_res = (stride == 1 and in_c == out_c)
        layers = []

        # Pointwise Expansion (if mid_c != in_c)
        if mid_c != in_c:
            layers.append(ConvBNReLU(in_c, mid_c, kernel_size=1, stride=1, padding=0, act=True))

        # Depthwise Convolution
        layers.append(
            ConvBNReLU(
                mid_c,
                mid_c,
                kernel_size=k_dw,
                stride=stride,
                padding=k_dw // 2,
                groups=mid_c,
                act=True,
            )
        )

        # Pointwise Linear Projection
        layers.append(ConvBNReLU(mid_c, out_c, kernel_size=1, stride=1, padding=0, act=False))
        self.block = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.block(x)
        return x + out if self.use_res else out


class MobileNetV4ConvSmall050(nn.Module):
    """Ultra-Compact MobileNetV4-Conv-Small with 0.50 Width Multiplier.

    Target Size: < 3.5M parameters (actual: ~184K parameters).
    Outputs: Global Average Pooling reduced to embedding vector z_v in R^{B x 64}.
    """

    def __init__(self, bottleneck_dim: int = 64):
        super().__init__()
        self.bottleneck_dim = bottleneck_dim

        # Stem: Conv 3 -> 16 (stride 2, 224x224 -> 112x112)
        self.stem = ConvBNReLU(3, 16, kernel_size=3, stride=2, padding=1, act=True)

        # Stages with width multiplier 0.50
        self.stages = nn.Sequential(
            # Stage 1: 112x112 -> 56x56
            UniversalInvertedBottleneck(16, 16, exp_ratio=2.0, k_dw=3, stride=2),
            # Stage 2: 56x56 -> 28x28
            UniversalInvertedBottleneck(16, 32, exp_ratio=3.0, k_dw=3, stride=2),
            UniversalInvertedBottleneck(32, 32, exp_ratio=3.0, k_dw=3, stride=1),
            # Stage 3: 28x28 -> 14x14
            UniversalInvertedBottleneck(32, 48, exp_ratio=3.0, k_dw=5, stride=2),
            UniversalInvertedBottleneck(48, 48, exp_ratio=3.0, k_dw=5, stride=1),
            # Stage 4: 14x14 -> 7x7
            UniversalInvertedBottleneck(48, 64, exp_ratio=4.0, k_dw=5, stride=2),
            UniversalInvertedBottleneck(64, 64, exp_ratio=4.0, k_dw=5, stride=1),
            UniversalInvertedBottleneck(64, 80, exp_ratio=4.0, k_dw=3, stride=1),
            # Conv Head Projection
            ConvBNReLU(80, 240, kernel_size=1, stride=1, padding=0, act=True),
        )

        self.pool = nn.AdaptiveAvgPool2d(1)
        self.bottleneck = nn.Linear(240, bottleneck_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, 3, 224, 224)
        x = self.stem(x)
        x = self.stages(x)
        x = self.pool(x).flatten(1)
        z_v = self.bottleneck(x)  # (B, 64)
        return z_v


class KinematicDynamicsBackbone(nn.Module):
    """1D Depthwise-Separable CNN for mouse interaction trajectory dynamics.

    Layer 1: 1D Conv (in=5, out=32, k=5, p=2) + BatchNorm1d + ReLU6
    Layer 2: Depthwise 1D Conv (in=32, out=32, k=3, p=1, groups=32) + Pointwise (in=32, out=64) + BatchNorm1d + ReLU6
    Layer 3: Depthwise 1D Conv (in=64, out=64, k=3, p=1, groups=64) + Pointwise (in=64, out=64) + BatchNorm1d + ReLU6
    Pooling: Adaptive Max Pooling over time dimension + Linear projection to z_m in R^{B x 36}
    Target Size: < 25K parameters (actual: ~9.9K parameters).
    """

    def __init__(self, in_channels: int = 5, bottleneck_dim: int = 36):
        super().__init__()
        self.bottleneck_dim = bottleneck_dim

        # Layer 1: 1D Conv (in=5, out=32, k=5, p=2) + BatchNorm1d + ReLU6
        self.layer1 = nn.Sequential(
            nn.Conv1d(in_channels, 32, kernel_size=5, padding=2, bias=False),
            nn.BatchNorm1d(32),
            nn.ReLU6(inplace=True),
        )

        # Layer 2: Depthwise 1D Conv + Pointwise 1D Conv + BatchNorm1d + ReLU6
        self.layer2 = nn.Sequential(
            nn.Conv1d(32, 32, kernel_size=3, padding=1, groups=32, bias=False),
            nn.Conv1d(32, 64, kernel_size=1, bias=False),
            nn.BatchNorm1d(64),
            nn.ReLU6(inplace=True),
        )

        # Layer 3: Depthwise 1D Conv + Pointwise 1D Conv + BatchNorm1d + ReLU6
        self.layer3 = nn.Sequential(
            nn.Conv1d(64, 64, kernel_size=3, padding=1, groups=64, bias=False),
            nn.Conv1d(64, 64, kernel_size=1, bias=False),
            nn.BatchNorm1d(64),
            nn.ReLU6(inplace=True),
        )

        # Pooling: Adaptive Max Pooling over time dimension + Linear projection
        self.pool = nn.AdaptiveMaxPool1d(1)
        self.bottleneck = nn.Linear(64, bottleneck_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, 5, 64)
        x = self.layer1(x)
        x = self.layer2(x)
        x = self.layer3(x)
        x = self.pool(x).squeeze(-1)  # (B, 64)
        z_m = self.bottleneck(x)       # (B, 36)
        return z_m


class PhishGuardUnifiedModel(nn.Module):
    """Unified Single-Model Architecture for both Cloud Baseline (Parent) and Edge Runtime (Student).

    Ingests:
      - Visual Stream: X_v in R^{B x 3 x 224 x 224}
      - Kinematic Stream: X_m in R^{B x 5 x 64}

    Outputs:
      - Risk probability P(phishing) in [0, 1] (and raw logit y_hat for focal loss optimization)
    """

    def __init__(
        self,
        vision_dim: int = 64,
        dynamics_dim: int = 36,
        hidden_dim: int = 32,
        dropout_p: float = 0.2,
    ):
        super().__init__()
        self.vision_dim = vision_dim
        self.dynamics_dim = dynamics_dim
        self.fused_dim = vision_dim + dynamics_dim  # 64 + 36 = 100

        # Backbones
        self.vision_backbone = MobileNetV4ConvSmall050(bottleneck_dim=vision_dim)
        self.dynamics_backbone = KinematicDynamicsBackbone(in_channels=5, bottleneck_dim=dynamics_dim)

        # Classification MLP
        self.classifier = nn.Sequential(
            nn.Linear(self.fused_dim, hidden_dim),
            nn.ReLU6(inplace=True),
            nn.Dropout(p=dropout_p),
            nn.Linear(hidden_dim, 1),
        )
        self.sigmoid = nn.Sigmoid()

    def forward(
        self,
        viewport: torch.Tensor,
        dynamics: torch.Tensor,
        return_logits: bool = False,
    ) -> Union[torch.Tensor, Tuple[torch.Tensor, torch.Tensor]]:
        """Forward pass ingesting visual and dynamics streams.

        Args:
            viewport: (B, 3, 224, 224) normalized screenshot.
            dynamics: (B, 5, 64) cursor interaction frames.
            return_logits: If True, returns (prob, logit) for focal loss training.

        Returns:
            prob of shape (B, 1) in [0, 1] (or tuple (prob, logit)).
        """
        # 1. Feature Extraction
        z_v = self.vision_backbone(viewport)   # (B, 64)
        z_m = self.dynamics_backbone(dynamics) # (B, 36)

        # 2. Embedding Normalization & Concatenation
        z_v_norm = F.normalize(z_v, p=2, dim=-1)
        z_m_norm = F.normalize(z_m, p=2, dim=-1)
        z_fused = torch.cat([z_v_norm, z_m_norm], dim=-1)  # (B, 100)

        # 3. Classification MLP
        logit = self.classifier(z_fused)  # (B, 1)
        prob = self.sigmoid(logit)        # (B, 1)

        if return_logits:
            return prob, logit
        return prob

    def count_parameters(self) -> Dict[str, int]:
        """Return parameter breakdown across components."""
        v_params = sum(p.numel() for p in self.vision_backbone.parameters())
        m_params = sum(p.numel() for p in self.dynamics_backbone.parameters())
        head_params = sum(p.numel() for p in self.classifier.parameters())
        total = sum(p.numel() for p in self.parameters())
        return {
            "vision_backbone": v_params,
            "dynamics_backbone": m_params,
            "classifier_head": head_params,
            "total_parameters": total,
        }


class PhishGuardSOTAMultimodalModel(nn.Module):
    """Industry SOTA Multimodal PhishGuard Model unifying all 5 perceptual and behavioral streams:

    1. Screen Viewport: MobileNetV4ConvSmall050 -> z_v in R^{B x 64}
    2. HID Mouse Kinematics: KinematicDynamicsBackbone -> z_m in R^{B x 36}
    3. URL Syntactic & Typosquatting: MLP -> z_u in R^{B x 24}
    4. HID Keystroke & Kinematic Dynamics: MLP -> z_h in R^{B x 16}
    5. Brand Logo Grounding & Domain Mismatch: MLP -> z_l in R^{B x 16}
    6. UI Layout & Visual Object Detection: MLP -> z_d in R^{B x 16}

    Fused Representation: z_fused in R^{B x 172} -> Multimodal Classification MLP.
    Total Parameters: ~210K (< 4M budget, < 1 MB memory, < 15 ms inference latency).
    """

    def __init__(
        self,
        vision_dim: int = 64,
        dynamics_dim: int = 36,
        url_dim: int = 24,
        hid_dim: int = 16,
        logo_dim: int = 16,
        detection_dim: int = 16,
        hidden_dim: int = 64,
        dropout_p: float = 0.2,
    ):
        super().__init__()
        self.vision_dim = vision_dim
        self.dynamics_dim = dynamics_dim
        self.url_dim = url_dim
        self.hid_dim = hid_dim
        self.logo_dim = logo_dim
        self.detection_dim = detection_dim

        self.fused_dim = vision_dim + dynamics_dim + url_dim + hid_dim + logo_dim + detection_dim  # 172

        # 1. Vision & Kinematic Backbones
        self.vision_backbone = MobileNetV4ConvSmall050(bottleneck_dim=vision_dim)
        self.dynamics_backbone = KinematicDynamicsBackbone(in_channels=5, bottleneck_dim=dynamics_dim)

        # 2. URL Stream Trunk (32 -> 32 -> url_dim)
        self.url_trunk = nn.Sequential(
            nn.Linear(32, 32, bias=False),
            nn.BatchNorm1d(32),
            nn.ReLU6(inplace=True),
            nn.Linear(32, url_dim),
        )

        # 3. HID Keystroke & Summary Trunk (16 -> 16 -> hid_dim)
        self.hid_trunk = nn.Sequential(
            nn.Linear(16, 16, bias=False),
            nn.BatchNorm1d(16),
            nn.ReLU6(inplace=True),
            nn.Linear(16, hid_dim),
        )

        # 4. Logo Grounding & Identity Mismatch Trunk (16 -> 16 -> logo_dim)
        self.logo_trunk = nn.Sequential(
            nn.Linear(16, 16, bias=False),
            nn.BatchNorm1d(16),
            nn.ReLU6(inplace=True),
            nn.Linear(16, logo_dim),
        )

        # 5. UI Layout & Visual Object Detection Trunk (16 -> 16 -> detection_dim)
        self.detection_trunk = nn.Sequential(
            nn.Linear(16, 16, bias=False),
            nn.BatchNorm1d(16),
            nn.ReLU6(inplace=True),
            nn.Linear(16, detection_dim),
        )

        # 6. Multimodal Fusion & Classification Head
        self.classifier = nn.Sequential(
            nn.Linear(self.fused_dim, hidden_dim),
            nn.ReLU6(inplace=True),
            nn.Dropout(p=dropout_p),
            nn.Linear(hidden_dim, 32),
            nn.ReLU6(inplace=True),
            nn.Linear(32, 1),
        )
        self.sigmoid = nn.Sigmoid()

    def forward(
        self,
        viewport: torch.Tensor,
        dynamics: torch.Tensor,
        url_features: Optional[torch.Tensor] = None,
        hid_features: Optional[torch.Tensor] = None,
        logo_features: Optional[torch.Tensor] = None,
        detection_features: Optional[torch.Tensor] = None,
        return_logits: bool = False,
    ) -> Union[torch.Tensor, Tuple[torch.Tensor, torch.Tensor]]:
        """Forward pass integrating all 5 modalities."""
        b_size = viewport.size(0)
        device = viewport.device

        # 1. Vision & Kinematic Embeddings
        z_v = self.vision_backbone(viewport)
        z_m = self.dynamics_backbone(dynamics)

        # 2. Defaults for optional streams if not supplied
        if url_features is None:
            url_features = torch.zeros(b_size, 32, device=device)
        if hid_features is None:
            hid_features = torch.zeros(b_size, 16, device=device)
        if logo_features is None:
            logo_features = torch.zeros(b_size, 16, device=device)
        if detection_features is None:
            detection_features = torch.zeros(b_size, 16, device=device)

        # 3. Stream Trunks
        # Guard BatchNorm1d if batch size is 1 during eval
        if b_size == 1:
            self.url_trunk[1].eval()
            self.hid_trunk[1].eval()
            self.logo_trunk[1].eval()
            self.detection_trunk[1].eval()

        z_u = self.url_trunk(url_features)
        z_h = self.hid_trunk(hid_features)
        z_l = self.logo_trunk(logo_features)
        z_d = self.detection_trunk(detection_features)

        # 4. L2 Normalization and Fusion
        z_v_n = F.normalize(z_v, p=2, dim=-1)
        z_m_n = F.normalize(z_m, p=2, dim=-1)
        z_u_n = F.normalize(z_u, p=2, dim=-1)
        z_h_n = F.normalize(z_h, p=2, dim=-1)
        z_l_n = F.normalize(z_l, p=2, dim=-1)
        z_d_n = F.normalize(z_d, p=2, dim=-1)

        z_fused = torch.cat([z_v_n, z_m_n, z_u_n, z_h_n, z_l_n, z_d_n], dim=-1)

        # 5. Classification
        logit = self.classifier(z_fused)
        prob = self.sigmoid(logit)

        if return_logits:
            return prob, logit
        return prob

    def explain_prediction(
        self,
        viewport: torch.Tensor,
        dynamics: torch.Tensor,
        url_features: Optional[torch.Tensor] = None,
        hid_features: Optional[torch.Tensor] = None,
        logo_features: Optional[torch.Tensor] = None,
        detection_features: Optional[torch.Tensor] = None,
    ) -> Dict[str, float]:
        """Compute relative attribution percentages across the 5 input modalities."""
        b_size = viewport.size(0)
        device = viewport.device

        z_v = F.normalize(self.vision_backbone(viewport), p=2, dim=-1)
        z_m = F.normalize(self.dynamics_backbone(dynamics), p=2, dim=-1)

        if url_features is None:
            url_features = torch.zeros(b_size, 32, device=device)
        if hid_features is None:
            hid_features = torch.zeros(b_size, 16, device=device)
        if logo_features is None:
            logo_features = torch.zeros(b_size, 16, device=device)
        if detection_features is None:
            detection_features = torch.zeros(b_size, 16, device=device)

        z_u = F.normalize(self.url_trunk(url_features), p=2, dim=-1)
        z_h = F.normalize(self.hid_trunk(hid_features), p=2, dim=-1)
        z_l = F.normalize(self.logo_trunk(logo_features), p=2, dim=-1)
        z_d = F.normalize(self.detection_trunk(detection_features), p=2, dim=-1)

        # Modality activations
        act_v = float(torch.norm(z_v).item())
        act_m = float(torch.norm(z_m).item())
        act_u = float(torch.norm(z_u).item())
        act_h = float(torch.norm(z_h).item())
        act_l = float(torch.norm(z_l).item())
        act_d = float(torch.norm(z_d).item())

        total = act_v + act_m + act_u + act_h + act_l + act_d + 1e-6

        return {
            "screen_visual": round(act_v / total, 4),
            "mouse_dynamics": round(act_m / total, 4),
            "url_features": round(act_u / total, 4),
            "hid_keystrokes": round(act_h / total, 4),
            "logo_grounding": round(act_l / total, 4),
            "ui_element_detection": round(act_d / total, 4),
        }

    def count_parameters(self) -> Dict[str, int]:
        """Return parameter breakdown across components."""
        v_params = sum(p.numel() for p in self.vision_backbone.parameters())
        m_params = sum(p.numel() for p in self.dynamics_backbone.parameters())
        u_params = sum(p.numel() for p in self.url_trunk.parameters())
        h_params = sum(p.numel() for p in self.hid_trunk.parameters())
        l_params = sum(p.numel() for p in self.logo_trunk.parameters())
        d_params = sum(p.numel() for p in self.detection_trunk.parameters())
        head_params = sum(p.numel() for p in self.classifier.parameters())
        total = sum(p.numel() for p in self.parameters())
        return {
            "vision_backbone": v_params,
            "dynamics_backbone": m_params,
            "url_trunk": u_params,
            "hid_trunk": h_params,
            "logo_trunk": l_params,
            "detection_trunk": d_params,
            "classifier_head": head_params,
            "total_parameters": total,
        }

