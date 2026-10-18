"""Behavioral 1D-CNN + BiLSTM trajectory encoder module.

Processes 6-channel kinematic pointer trajectories [x, y, dx, dy, v, theta]
to capture local tremor/jerk features via 1D convolutions and long-range sequential
hesitation/aiming patterns via a bidirectional LSTM with temporal attention pooling.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F


class TemporalAttentionPooling(nn.Module):
    """Computes soft attention weights across sequence length T and aggregates."""

    def __init__(self, hidden_dim: int):
        super().__init__()
        self.attn = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.Tanh(),
            nn.Linear(hidden_dim // 2, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x shape: (B, T, D)
        weights = self.attn(x)  # (B, T, 1)
        weights = F.softmax(weights, dim=1)
        pooled = torch.sum(x * weights, dim=1)  # (B, D)
        return pooled


class BehavioralCNNLSTM(nn.Module):
    """1D-CNN + BiLSTM behavioral backbone for mouse interaction dynamics."""

    def __init__(
        self,
        in_channels: int = 6,
        cnn_channels: int = 64,
        lstm_hidden_dim: int = 64,
        lstm_layers: int = 2,
        dropout: float = 0.2,
    ):
        super().__init__()
        self.in_channels = in_channels
        self.embedding_dim = lstm_hidden_dim * 2  # Bidirectional

        # Local temporal feature extraction (micro-tremor, abrupt jerks)
        self.conv1 = nn.Conv1d(in_channels, cnn_channels // 2, kernel_size=3, padding=1)
        self.bn1 = nn.BatchNorm1d(cnn_channels // 2)
        self.conv2 = nn.Conv1d(cnn_channels // 2, cnn_channels, kernel_size=3, padding=1)
        self.bn2 = nn.BatchNorm1d(cnn_channels)
        self.act = nn.GELU()

        # Sequential dynamics (hesitation, overshoot, trajectory curvature)
        self.lstm = nn.LSTM(
            input_size=cnn_channels,
            hidden_size=lstm_hidden_dim,
            num_layers=lstm_layers,
            batch_first=True,
            bidirectional=True,
            dropout=dropout if lstm_layers > 1 else 0.0,
        )

        # Attention pooling across sequence length T=128
        self.pooling = TemporalAttentionPooling(self.embedding_dim)

        # Projection & risk classification head
        self.classifier = nn.Sequential(
            nn.Linear(self.embedding_dim, 32),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(32, 1),
        )

    def extract_features(self, x: torch.Tensor) -> torch.Tensor:
        """Extract fixed-dimensional behavioral embedding d_b = 128.

        Args:
            x: Tensor of shape (B, 128, 6) or (B, 6, 128)
        Returns:
            Tensor of shape (B, 128)
        """
        if x.dim() != 3:
            raise ValueError(f"Expected 3D tensor (B, T, C), got shape {x.shape}")

        # Ensure shape (B, C, T) for Conv1D
        if x.size(1) != self.in_channels and x.size(2) == self.in_channels:
            x = x.transpose(1, 2)  # (B, 6, 128)

        # CNN feature maps
        h = self.act(self.bn1(self.conv1(x)))
        h = self.act(self.bn2(self.conv2(h)))

        # Reshape to (B, T, C) for LSTM
        h = h.transpose(1, 2)

        # BiLSTM
        lstm_out, _ = self.lstm(h)  # (B, T, 128)

        # Attention pooling
        embedding = self.pooling(lstm_out)  # (B, 128)
        return embedding

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Forward pass outputting calibrated sigmoid risk probability in [0, 1]."""
        emb = self.extract_features(x)
        logits = self.classifier(emb)
        return torch.sigmoid(logits)
