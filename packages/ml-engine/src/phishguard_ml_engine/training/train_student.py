"""Training and knowledge distillation modules."""

import torch
import torch.nn as nn
import torch.optim as optim
from typing import Dict, Any

from ..models.student_model import DistilledStudentModel
from ..data.bezier_synthesizer import generate_synthetic_trajectory
from ..data.trajectory_dataset import create_trajectory_dataloader


def train_student_epoch(
    model: DistilledStudentModel,
    dataloader: torch.utils.data.DataLoader,
    optimizer: optim.Optimizer,
    criterion: nn.Module,
    device: torch.device,
) -> float:
    """Train student model for one epoch."""
    model.train()
    total_loss = 0.0
    for trajs, labels in dataloader:
        trajs = trajs.to(device)
        labels = labels.to(device)

        optimizer.zero_grad()
        preds = model(trajs)
        loss = criterion(preds, labels)
        loss.backward()
        optimizer.step()

        total_loss += loss.item() * len(labels)

    return total_loss / len(dataloader.dataset)


def run_synthetic_training_benchmark(epochs: int = 3, num_samples: int = 64) -> Dict[str, Any]:
    """Train a lightweight student model on synthetic behavioral data."""
    device = torch.device("cpu")
    samples = [
        generate_synthetic_trajectory(is_phishing=(i % 2 == 1), num_steps=64)
        for i in range(num_samples)
    ]
    labels = [i % 2 for i in range(num_samples)]

    loader = create_trajectory_dataloader(samples, labels, batch_size=16, shuffle=True)
    model = DistilledStudentModel(behavioral_in_channels=6, behavioral_dim=64, include_visual=False).to(device)
    optimizer = optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    criterion = nn.BCELoss()

    history = []
    for ep in range(epochs):
        loss = train_student_epoch(model, loader, optimizer, criterion, device)
        history.append(loss)

    return {
        "final_loss": history[-1],
        "epochs": epochs,
        "model": model,
    }
