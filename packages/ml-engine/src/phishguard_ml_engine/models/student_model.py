"""Distilled Edge Student Model for On-Device Inferencing.

Targeted for browser execution (< 80 MB, < 150 MB RAM, < 40 ms latency)
using ONNX Runtime Web (WebGPU / WASM).
"""

import torch
import torch.nn as nn
from .behavioral_cnn_lstm import BehavioralCNNLSTM


class LightweightVisualTrunk(nn.Module):
    """Compact depthwise-separable visual trunk for downsampled viewport screenshots (64x64)."""

    def __init__(self, in_channels: int = 3, out_dim: int = 64):
        super().__init__()
        self.net = nn.Sequential(
            # Conv block 1
            nn.Conv2d(in_channels, 16, kernel_size=3, stride=2, padding=1),  # 32x32
            nn.BatchNorm2d(16),
            nn.ReLU6(),
            # Depthwise separable block 1
            nn.Conv2d(16, 16, kernel_size=3, stride=2, padding=1, groups=16),  # 16x16
            nn.Conv2d(16, 32, kernel_size=1),
            nn.BatchNorm2d(32),
            nn.ReLU6(),
            # Depthwise separable block 2
            nn.Conv2d(32, 32, kernel_size=3, stride=2, padding=1, groups=32),  # 8x8
            nn.Conv2d(32, 64, kernel_size=1),
            nn.BatchNorm2d(64),
            nn.ReLU6(),
            # Global Average Pooling
            nn.AdaptiveAvgPool2d((1, 1)),
            nn.Flatten(),
            nn.Linear(64, out_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class DistilledStudentModel(nn.Module):
    """Distilled On-Device Multimodal Student Engine."""

    def __init__(
        self,
        behavioral_in_channels: int = 6,
        behavioral_dim: int = 128,
        visual_dim: int = 64,
        include_visual: bool = True,
        include_page_context: bool = False,
    ):
        super().__init__()
        self.include_visual = include_visual
        self.include_page_context = include_page_context

        # Lightweight 1D-CNN + BiLSTM behavioral trunk
        self.behavior_trunk = BehavioralCNNLSTM(
            in_channels=behavioral_in_channels,
            cnn_channels=32,
            lstm_hidden_dim=behavioral_dim // 2,
            lstm_layers=1,  # 1 layer for fast edge inference
        )

        total_dim = behavioral_dim
        if include_visual:
            self.visual_trunk = LightweightVisualTrunk(in_channels=3, out_dim=visual_dim)
            total_dim += visual_dim
        else:
            self.visual_trunk = None
        if include_page_context:
            self.context_trunk = nn.Sequential(nn.Linear(16, 16), nn.GELU())
            total_dim += 16
            self.register_buffer("calibration_temperature", torch.ones(1))
            self.register_buffer("calibration_bias", torch.zeros(1))
        else:
            self.context_trunk = None

        # Multimodal fusion & risk projection head
        self.fusion_head = nn.Sequential(
            nn.Linear(total_dim, 64),
            nn.GELU(),
            nn.Linear(64, 1),
        )

    def forward(
        self,
        trajectory: torch.Tensor,
        visual: torch.Tensor = None,
        page_context: torch.Tensor = None,
    ) -> torch.Tensor:
        """
        Args:
            trajectory: (B, 128, 6) pointer kinematics sequence.
            visual: Optional (B, 3, 64, 64) normalized viewport image.
        Returns:
            Risk probability tensor of shape (B, 1) in range [0, 1].
        """
        logits = self.forward_logits(trajectory, visual, page_context)
        if self.include_page_context:
            logits = logits / self.calibration_temperature + self.calibration_bias
        return torch.sigmoid(logits)

    def forward_logits(
        self,
        trajectory: torch.Tensor,
        visual: torch.Tensor = None,
        page_context: torch.Tensor = None,
    ) -> torch.Tensor:
        b_feat = self.behavior_trunk.extract_features(trajectory)  # (B, 128)
        if self.include_page_context:
            if page_context is None:
                raise ValueError("student-v2 requires page_context")
            b_feat = b_feat * page_context[:, 12:13]

        if self.include_visual and visual is not None:
            v_feat = self.visual_trunk(visual)  # (B, 64)
            if self.include_page_context:
                v_feat = v_feat * page_context[:, 13:14]
            fused = torch.cat([b_feat, v_feat], dim=-1)
        else:
            fused = b_feat
        if self.include_page_context:
            fused = torch.cat([fused, self.encode_context(page_context)], dim=-1)

        logits = self.fusion_head(fused)
        return logits

    def encode_context(self, page_context: torch.Tensor) -> torch.Tensor:
        risk_context = torch.cat([page_context[:, :15], torch.zeros_like(page_context[:, 15:16])], dim=-1)
        return self.context_trunk(risk_context)
