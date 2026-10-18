"""Focal + Brier Calibration Loss and Learning Rate Scheduling for PhishGuard Unified Model."""

import math
from typing import Tuple
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.optim.lr_scheduler import LambdaLR


class FocalBrierCalibrationLoss(nn.Module):
    """Combined Focal Loss + Brier Score Calibration Objective.

    Loss Formulation:
      L = L_Focal(y_hat, y) + lambda * L_Brier(sigma(y_hat), y)

    Parameters:
      alpha: 0.65 (higher penalty on false negatives to prioritize security safety).
      gamma: 2.0 (focal focusing parameter down-weighting easy benign examples).
      brier_lambda: 0.1 (enforces well-calibrated output probabilities for tri-state decisions).
    """

    def __init__(
        self,
        alpha: float = 0.65,
        gamma: float = 2.0,
        brier_lambda: float = 0.1,
    ):
        super().__init__()
        self.alpha = alpha
        self.gamma = gamma
        self.brier_lambda = brier_lambda

    def forward(
        self,
        logits: torch.Tensor,
        targets: torch.Tensor,
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """Compute combined loss.

        Args:
            logits: (B, 1) raw unnormalized logits y_hat.
            targets: (B, 1) binary ground truth labels y in {0, 1}.

        Returns:
            Tuple of (total_loss, focal_loss, brier_loss).
        """
        targets = targets.view_as(logits).float()
        probs = torch.sigmoid(logits)

        # 1. Numerically Stable Focal Loss
        bce = F.binary_cross_entropy_with_logits(logits, targets, reduction="none")
        p_t = torch.exp(-bce)  # p_t = p if y==1 else (1-p)
        alpha_t = targets * self.alpha + (1.0 - targets) * (1.0 - self.alpha)
        focal_weight = alpha_t * torch.pow(1.0 - p_t, self.gamma)
        focal_loss = (focal_weight * bce).mean()

        # 2. Brier Score Calibration Loss: MSE between probability and true label
        brier_loss = torch.pow(probs - targets, 2).mean()

        # 3. Combined Objective
        total_loss = focal_loss + self.brier_lambda * brier_loss

        return total_loss, focal_loss, brier_loss


def build_warmup_cosine_scheduler(
    optimizer: torch.optim.Optimizer,
    warmup_epochs: int = 3,
    total_epochs: int = 25,
    min_lr_ratio: float = 0.01,
) -> LambdaLR:
    """Create a scheduler with linear warmup for 3 epochs followed by Cosine Annealing."""

    def lr_lambda(current_epoch: int) -> float:
        if current_epoch < warmup_epochs:
            # Linear warmup: starts from 1/warmup_epochs up to 1.0
            return float(current_epoch + 1) / float(max(1, warmup_epochs))
        else:
            # Cosine decay from 1.0 down to min_lr_ratio
            progress = float(current_epoch - warmup_epochs) / float(max(1, total_epochs - warmup_epochs))
            cosine_factor = 0.5 * (1.0 + math.cos(math.pi * progress))
            return min_lr_ratio + (1.0 - min_lr_ratio) * cosine_factor

    return LambdaLR(optimizer, lr_lambda=lr_lambda)
