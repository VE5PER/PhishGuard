"""Training pipeline for PhishGuard Unified Model with Focal + Brier Calibration."""

from typing import Any, Dict, List, Optional, Tuple
import numpy as np
import torch
from torch.utils.data import DataLoader

from .unified_model import PhishGuardUnifiedModel
from .losses import FocalBrierCalibrationLoss, build_warmup_cosine_scheduler


def train_unified_epoch(
    model: PhishGuardUnifiedModel,
    dataloader: DataLoader,
    optimizer: torch.optim.Optimizer,
    criterion: FocalBrierCalibrationLoss,
    device: torch.device,
) -> Dict[str, float]:
    """Execute one training epoch."""
    model.train()
    total_loss_accum = 0.0
    focal_loss_accum = 0.0
    brier_loss_accum = 0.0
    num_samples = 0

    for viewports, dynamics, labels in dataloader:
        viewports = viewports.to(device)
        dynamics = dynamics.to(device)
        labels = labels.to(device)
        batch_size = labels.size(0)

        optimizer.zero_grad()
        _, logits = model(viewports, dynamics, return_logits=True)
        total_loss, focal_loss, brier_loss = criterion(logits, labels)

        total_loss.backward()
        # Gradient clipping for stable convergence
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()

        total_loss_accum += total_loss.item() * batch_size
        focal_loss_accum += focal_loss.item() * batch_size
        brier_loss_accum += brier_loss.item() * batch_size
        num_samples += batch_size

    n = max(num_samples, 1)
    return {
        "loss": total_loss_accum / n,
        "focal_loss": focal_loss_accum / n,
        "brier_loss": brier_loss_accum / n,
    }


def evaluate_unified_epoch(
    model: PhishGuardUnifiedModel,
    dataloader: DataLoader,
    criterion: FocalBrierCalibrationLoss,
    device: torch.device,
) -> Dict[str, float]:
    """Execute one validation epoch and compute classification metrics."""
    model.eval()
    total_loss_accum = 0.0
    focal_loss_accum = 0.0
    brier_loss_accum = 0.0
    all_preds = []
    all_targets = []
    num_samples = 0

    with torch.no_grad():
        for viewports, dynamics, labels in dataloader:
            viewports = viewports.to(device)
            dynamics = dynamics.to(device)
            labels = labels.to(device)
            batch_size = labels.size(0)

            probs, logits = model(viewports, dynamics, return_logits=True)
            total_loss, focal_loss, brier_loss = criterion(logits, labels)

            total_loss_accum += total_loss.item() * batch_size
            focal_loss_accum += focal_loss.item() * batch_size
            brier_loss_accum += brier_loss.item() * batch_size
            num_samples += batch_size

            all_preds.extend(probs.cpu().squeeze(-1).numpy().tolist())
            all_targets.extend(labels.cpu().squeeze(-1).numpy().tolist())

    n = max(num_samples, 1)
    preds_arr = np.array(all_preds)
    targets_arr = np.array(all_targets)
    binary_preds = (preds_arr >= 0.5).astype(float)

    tp = float(np.sum((binary_preds == 1.0) & (targets_arr == 1.0)))
    tn = float(np.sum((binary_preds == 0.0) & (targets_arr == 0.0)))
    fp = float(np.sum((binary_preds == 1.0) & (targets_arr == 0.0)))
    fn = float(np.sum((binary_preds == 0.0) & (targets_arr == 1.0)))

    accuracy = (tp + tn) / max(len(targets_arr), 1)
    precision = tp / max(tp + fp, 1e-8)
    recall = tp / max(tp + fn, 1e-8)
    f1 = (2 * precision * recall) / max(precision + recall, 1e-8)

    return {
        "val_loss": total_loss_accum / n,
        "val_focal_loss": focal_loss_accum / n,
        "val_brier_loss": brier_loss_accum / n,
        "val_accuracy": float(accuracy),
        "val_precision": float(precision),
        "val_recall": float(recall),
        "val_f1": float(f1),
    }


def train_unified_model(
    model: PhishGuardUnifiedModel,
    train_loader: DataLoader,
    val_loader: DataLoader,
    epochs: int = 25,
    warmup_epochs: int = 3,
    lr: float = 5e-4,
    weight_decay: float = 1e-3,
    alpha: float = 0.65,
    gamma: float = 2.0,
    brier_lambda: float = 0.1,
    device: Optional[torch.device] = None,
) -> Dict[str, Any]:
    """Train PhishGuardUnifiedModel using AdamW and Warmup Cosine Annealing."""
    dev = device or torch.device("cpu")
    model = model.to(dev)

    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    scheduler = build_warmup_cosine_scheduler(
        optimizer, warmup_epochs=warmup_epochs, total_epochs=epochs
    )
    criterion = FocalBrierCalibrationLoss(alpha=alpha, gamma=gamma, brier_lambda=brier_lambda)

    history: List[Dict[str, float]] = []
    best_val_loss = float("inf")
    best_state_dict: Optional[Dict[str, torch.Tensor]] = None

    for ep in range(epochs):
        train_metrics = train_unified_epoch(model, train_loader, optimizer, criterion, dev)
        val_metrics = evaluate_unified_epoch(model, val_loader, criterion, dev)
        scheduler.step()

        epoch_record = {
            "epoch": ep + 1,
            "lr": optimizer.param_groups[0]["lr"],
            **train_metrics,
            **val_metrics,
        }
        history.append(epoch_record)

        if val_metrics["val_loss"] < best_val_loss:
            best_val_loss = val_metrics["val_loss"]
            best_state_dict = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    # Restore best checkpoint
    if best_state_dict is not None:
        model.load_state_dict(best_state_dict)

    return {
        "model": model,
        "history": history,
        "best_val_loss": best_val_loss,
        "final_metrics": history[-1] if history else {},
    }


def train_sota_epoch(
    model: torch.nn.Module,
    dataloader: DataLoader,
    optimizer: torch.optim.Optimizer,
    criterion: FocalBrierCalibrationLoss,
    device: torch.device,
) -> Dict[str, float]:
    """Execute one training epoch for the 5-stream SOTA multimodal model."""
    model.train()
    total_loss_accum = 0.0
    focal_loss_accum = 0.0
    brier_loss_accum = 0.0
    num_samples = 0

    for batch in dataloader:
        vp, dyn, url, hid, logo, det, lbl = [item.to(device) for item in batch]
        b_size = lbl.size(0)

        optimizer.zero_grad()
        _, logits = model(
            viewport=vp,
            dynamics=dyn,
            url_features=url,
            hid_features=hid,
            logo_features=logo,
            detection_features=det,
            return_logits=True,
        )
        total_loss, focal_loss, brier_loss = criterion(logits, lbl)

        total_loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()

        total_loss_accum += total_loss.item() * b_size
        focal_loss_accum += focal_loss.item() * b_size
        brier_loss_accum += brier_loss.item() * b_size
        num_samples += b_size

    n = max(num_samples, 1)
    return {
        "loss": total_loss_accum / n,
        "focal_loss": focal_loss_accum / n,
        "brier_loss": brier_loss_accum / n,
    }


def evaluate_sota_epoch(
    model: torch.nn.Module,
    dataloader: DataLoader,
    criterion: FocalBrierCalibrationLoss,
    device: torch.device,
) -> Dict[str, float]:
    """Evaluate 5-stream SOTA multimodal model and compute industry benchmark metrics."""
    model.eval()
    total_loss_accum = 0.0
    focal_loss_accum = 0.0
    brier_loss_accum = 0.0
    all_preds = []
    all_targets = []
    num_samples = 0

    with torch.no_grad():
        for batch in dataloader:
            vp, dyn, url, hid, logo, det, lbl = [item.to(device) for item in batch]
            b_size = lbl.size(0)

            probs, logits = model(
                viewport=vp,
                dynamics=dyn,
                url_features=url,
                hid_features=hid,
                logo_features=logo,
                detection_features=det,
                return_logits=True,
            )
            total_loss, focal_loss, brier_loss = criterion(logits, lbl)

            total_loss_accum += total_loss.item() * b_size
            focal_loss_accum += focal_loss.item() * b_size
            brier_loss_accum += brier_loss.item() * b_size
            num_samples += b_size

            all_preds.extend(probs.cpu().squeeze(-1).numpy().tolist())
            all_targets.extend(lbl.cpu().squeeze(-1).numpy().tolist())

    n = max(num_samples, 1)
    preds_arr = np.array(all_preds)
    targets_arr = np.array(all_targets)
    binary_preds = (preds_arr >= 0.5).astype(float)

    tp = float(np.sum((binary_preds == 1.0) & (targets_arr == 1.0)))
    tn = float(np.sum((binary_preds == 0.0) & (targets_arr == 0.0)))
    fp = float(np.sum((binary_preds == 1.0) & (targets_arr == 0.0)))
    fn = float(np.sum((binary_preds == 0.0) & (targets_arr == 1.0)))

    accuracy = (tp + tn) / max(len(targets_arr), 1)
    precision = tp / max(tp + fp, 1e-8)
    recall = tp / max(tp + fn, 1e-8)
    f1 = (2 * precision * recall) / max(precision + recall, 1e-8)
    fpr = fp / max(fp + tn, 1e-8)

    # ROC-AUC calculation
    roc_auc = 1.0
    try:
        from sklearn.metrics import roc_auc_score
        if len(np.unique(targets_arr)) > 1:
            roc_auc = float(roc_auc_score(targets_arr, preds_arr))
    except Exception:
        pass

    # Brier calibration score (mean squared error of probabilities)
    brier_score = float(np.mean((preds_arr - targets_arr) ** 2))

    return {
        "val_loss": total_loss_accum / n,
        "val_focal_loss": focal_loss_accum / n,
        "val_brier_loss": brier_loss_accum / n,
        "val_accuracy": float(accuracy),
        "val_precision": float(precision),
        "val_recall": float(recall),
        "val_f1": float(f1),
        "val_fpr": float(fpr),
        "val_roc_auc": float(roc_auc),
        "val_brier_score": float(brier_score),
    }


def train_sota_multimodal_model(
    model: torch.nn.Module,
    train_loader: DataLoader,
    val_loader: DataLoader,
    epochs: int = 20,
    warmup_epochs: int = 2,
    lr: float = 8e-4,
    weight_decay: float = 1e-3,
    alpha: float = 0.65,
    gamma: float = 2.0,
    brier_lambda: float = 0.1,
    device: Optional[torch.device] = None,
) -> Dict[str, Any]:
    """Train SOTA multimodal model with Warmup Cosine scheduler and Focal-Brier Loss."""
    dev = device or torch.device("cpu")
    model = model.to(dev)

    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    scheduler = build_warmup_cosine_scheduler(
        optimizer, warmup_epochs=warmup_epochs, total_epochs=epochs
    )
    criterion = FocalBrierCalibrationLoss(alpha=alpha, gamma=gamma, brier_lambda=brier_lambda)

    history: List[Dict[str, float]] = []
    best_val_loss = float("inf")
    best_state_dict: Optional[Dict[str, torch.Tensor]] = None

    for ep in range(epochs):
        train_metrics = train_sota_epoch(model, train_loader, optimizer, criterion, dev)
        val_metrics = evaluate_sota_epoch(model, val_loader, criterion, dev)
        scheduler.step()

        epoch_record = {
            "epoch": ep + 1,
            "lr": optimizer.param_groups[0]["lr"],
            **train_metrics,
            **val_metrics,
        }
        history.append(epoch_record)

        if val_metrics["val_loss"] < best_val_loss:
            best_val_loss = val_metrics["val_loss"]
            best_state_dict = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    if best_state_dict is not None:
        model.load_state_dict(best_state_dict)

    return {
        "model": model,
        "history": history,
        "best_val_loss": best_val_loss,
        "final_metrics": history[-1] if history else {},
    }

