"""Parent Multimodal Cloud Teacher Model Architecture.

Combines high-capacity Vision representations (e.g., SigLIP / ViT),
DOM topological hierarchy, Dynamics (1D-CNN + BiLSTM), URL lexical features,
and Logo identity grounding with late cross-attention fusion. Produces calibrated
risk logits and soft targets for student distillation.
"""

from typing import Optional, Tuple
import torch
import torch.nn as nn
from .behavioral_cnn_lstm import BehavioralCNNLSTM


class TeacherMultimodalModel(nn.Module):
    """Cloud Teacher Model for high-precision multimodal phishing analysis."""

    def __init__(
        self,
        vision_dim: int = 256,
        dom_dim: int = 128,
        dynamics_dim: int = 128,
        url_dim: int = 32,
        logo_dim: int = 16,
        fusion_dim: int = 256,
        num_heads: int = 4,
    ):
        super().__init__()
        self.vision_dim = vision_dim
        self.dom_dim = dom_dim
        self.dynamics_dim = dynamics_dim
        self.url_dim = url_dim
        self.logo_dim = logo_dim
        self.fusion_dim = fusion_dim

        # Behavioral dynamics trunk
        self.dynamics_trunk = BehavioralCNNLSTM(
            in_channels=6,
            cnn_channels=64,
            lstm_hidden_dim=dynamics_dim // 2,
            lstm_layers=2,
        )

        # Linear projections into shared multimodal space
        self.proj_vision = nn.Linear(vision_dim, fusion_dim)
        self.proj_dom = nn.Linear(dom_dim, fusion_dim)
        self.proj_dyn = nn.Linear(dynamics_dim, fusion_dim)
        self.proj_url = nn.Linear(url_dim, fusion_dim)
        self.proj_logo = nn.Linear(logo_dim, fusion_dim)

        # Cross-stream multi-head self-attention
        self.attention = nn.MultiheadAttention(
            embed_dim=fusion_dim,
            num_heads=num_heads,
            batch_first=True,
        )

        self.norm = nn.LayerNorm(fusion_dim)

        # Classification and explanation heads
        # Projection from pooled multi-stream tokens
        self.head = nn.Sequential(
            nn.Linear(fusion_dim, 128),
            nn.GELU(),
            nn.Linear(128, 1),
        )

    def forward(
        self,
        trajectory: torch.Tensor,
        vision_features: torch.Tensor,
        dom_features: torch.Tensor,
        url_features: Optional[torch.Tensor] = None,
        logo_features: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        Args:
            trajectory: (B, 128, 6) pointer kinematics sequence.
            vision_features: (B, vision_dim) e.g., SigLIP patch representation.
            dom_features: (B, dom_dim) flattened DOM topological tokens.
            url_features: Optional (B, url_dim) lexical and typosquatting tokens.
            logo_features: Optional (B, logo_dim) brand grounding tokens.

        Returns:
            Tuple of (risk_probabilities, raw_logits)
        """
        b_size = trajectory.size(0)
        device = trajectory.device

        dyn_feat = self.dynamics_trunk.extract_features(trajectory)  # (B, dynamics_dim)

        # Project base streams to fusion_dim
        v_proj = self.proj_vision(vision_features).unsqueeze(1)  # (B, 1, fusion_dim)
        d_proj = self.proj_dom(dom_features).unsqueeze(1)        # (B, 1, fusion_dim)
        b_proj = self.proj_dyn(dyn_feat).unsqueeze(1)            # (B, 1, fusion_dim)

        token_list = [v_proj, d_proj, b_proj]

        if url_features is not None:
            u_proj = self.proj_url(url_features).unsqueeze(1)
            token_list.append(u_proj)
        if logo_features is not None:
            l_proj = self.proj_logo(logo_features).unsqueeze(1)
            token_list.append(l_proj)

        # Stack into sequence of tokens [Vision, DOM, Dynamics, (URL, Logo)]
        tokens = torch.cat(token_list, dim=1)  # (B, num_modalities, fusion_dim)

        attn_out, _ = self.attention(tokens, tokens, tokens)
        tokens = self.norm(tokens + attn_out)

        # Mean pooling over active modalities
        pooled = tokens.mean(dim=1)  # (B, fusion_dim)
        logits = self.head(pooled)
        probs = torch.sigmoid(logits)

        return probs, logits
