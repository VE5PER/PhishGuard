"""Training & Distillation Pipeline for PhishGuard behavioral models."""

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader

from phishguard_ml_engine.models.student_model import DistilledStudentModel
from phishguard_ml_engine.models.teacher_multimodal import TeacherMultimodalModel
from phishguard_ml_engine.data.bezier_synthesizer import generate_synthetic_trajectory
from phishguard_ml_engine.data.trajectory_dataset import create_trajectory_dataloader
from phishguard_ml_engine.data.multimodal_generator import generate_multimodal_dataset_batch
from phishguard_ml_engine.data.industrial_benchmark_dataset import build_industrial_benchmark_dataset

from phishguard_types import DatasetManifest, SOTABenchmarkReport
from .checkpoint_manager import CheckpointManager
from .dataset import create_sota_multimodal_dataloader
from .dataset_storage import store_multimodal_dataset, load_dataset_manifest, SOTA_BENCHMARK_TARGETS
from .unified_model import PhishGuardSOTAMultimodalModel
from .unified_training import train_sota_multimodal_model, evaluate_sota_epoch
from .losses import FocalBrierCalibrationLoss
from .visual_student import create_visual_student_loaders


class TrainingPipeline:
    """Manages model training runs, validation loops, distillation, and checkpointing."""

    def __init__(
        self,
        checkpoint_manager: Optional[CheckpointManager] = None,
        device: Optional[torch.device] = None,
    ):
        self.checkpoint_manager = checkpoint_manager or CheckpointManager()
        self.device = device or torch.device("cpu")

    def generate_synthetic_dataset(
        self,
        num_samples: int = 128,
        seq_length: int = 128,
        batch_size: int = 16,
        split_ratio: float = 0.8,
    ) -> tuple[DataLoader, DataLoader]:
        """Generate balanced synthetic trajectory datasets with physiological tremor noise."""
        samples = [
            generate_synthetic_trajectory(
                is_phishing=(i % 2 == 1),
                num_steps=seq_length,
            )
            for i in range(num_samples)
        ]
        labels = [1.0 if (i % 2 == 1) else 0.0 for i in range(num_samples)]

        split_idx = int(num_samples * split_ratio)
        train_samples, val_samples = samples[:split_idx], samples[split_idx:]
        train_labels, val_labels = labels[:split_idx], labels[split_idx:]

        train_loader = create_trajectory_dataloader(
            train_samples, train_labels, batch_size=batch_size, shuffle=True
        )
        val_loader = create_trajectory_dataloader(
            val_samples, val_labels, batch_size=batch_size, shuffle=False
        )

        return train_loader, val_loader

    def train_student(
        self,
        config: Optional[Dict[str, Any]] = None,
        num_samples: int = 128,
        checkpoint_every_epoch: bool = True,
    ) -> Dict[str, Any]:
        """Execute end-to-end student model training run with checkpointing."""
        cfg = config or {}
        if cfg.get("include_page_context", False):
            import json
            from datetime import datetime, timezone
            from .context_training import train_context_candidate
            manifest_path = cfg.get("corpus_manifest")
            if not manifest_path:
                raise ValueError("Context student training requires a frozen corpus_manifest")
            manifest = json.loads(Path(manifest_path).read_text())
            root = Path(__file__).resolve().parents[4]
            output = self.checkpoint_manager.raw_dir / f"context_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S_%f')}"
            return train_context_candidate(
                root, manifest, output, cfg.get("seed", 0),
                epochs=cfg.get("hyperparameters", {}).get("epochs", 15),
                batch_size=cfg.get("hyperparameters", {}).get("batch_size", 32),
            )
        if cfg.get("include_visual", False):
            return self.train_visual_student(cfg, num_samples=num_samples, checkpoint_every_epoch=checkpoint_every_epoch)

        hp = cfg.get("hyperparameters", {})
        epochs = hp.get("epochs", 5)
        batch_size = hp.get("batch_size", 16)
        lr = hp.get("learning_rate", 1e-3)
        weight_decay = hp.get("weight_decay", 1e-4)
        seq_len = cfg.get("seq_length", 128)

        train_loader, val_loader = self.generate_synthetic_dataset(
            num_samples=num_samples,
            seq_length=seq_len,
            batch_size=batch_size,
        )

        model = DistilledStudentModel(
            behavioral_in_channels=cfg.get("behavioral_in_channels", 6),
            behavioral_dim=cfg.get("behavioral_dim", 64),
            include_visual=cfg.get("include_visual", False),
        ).to(self.device)

        optimizer = optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
        criterion = nn.BCELoss()

        best_val_loss = float("inf")
        best_checkpoint_path: Optional[torch.Path] = None
        history: List[Dict[str, float]] = []

        for ep in range(epochs):
            # Training epoch
            model.train()
            train_loss = 0.0
            for trajs, labels in train_loader:
                trajs = trajs.to(self.device)
                labels = labels.to(self.device).float()

                optimizer.zero_grad()
                preds = model(trajs)
                loss = criterion(preds, labels)
                loss.backward()
                optimizer.step()

                train_loss += loss.item() * len(labels)
            train_loss /= len(train_loader.dataset)

            # Validation epoch
            model.eval()
            val_loss = 0.0
            correct = 0
            total = 0
            with torch.no_grad():
                for trajs, labels in val_loader:
                    trajs = trajs.to(self.device)
                    labels = labels.to(self.device).float()
                    preds = model(trajs)
                    loss = criterion(preds, labels)
                    val_loss += loss.item() * len(labels)

                    pred_binary = (preds >= 0.5).float()
                    correct += (pred_binary == labels).sum().item()
                    total += len(labels)

            val_loss /= len(val_loader.dataset)
            accuracy = correct / max(total, 1)

            epoch_metrics = {
                "train_loss": round(train_loss, 4),
                "val_loss": round(val_loss, 4),
                "val_accuracy": round(accuracy, 4),
            }
            history.append(epoch_metrics)

            if checkpoint_every_epoch or val_loss < best_val_loss:
                chk_path = self.checkpoint_manager.save_raw_checkpoint(
                    model=model,
                    optimizer=optimizer,
                    epoch=ep + 1,
                    step=(ep + 1) * len(train_loader),
                    loss=val_loss,
                    metrics=epoch_metrics,
                    config=cfg,
                )
                if val_loss < best_val_loss:
                    best_val_loss = val_loss
                    best_checkpoint_path = chk_path

        return {
            "model": model,
            "best_val_loss": best_val_loss,
            "best_checkpoint_path": str(best_checkpoint_path) if best_checkpoint_path else None,
            "history": history,
            "epochs_completed": epochs,
        }

    def train_visual_student(
        self,
        config: Dict[str, Any],
        num_samples: int = 1024,
        checkpoint_every_epoch: bool = False,
        visual_dropout: float = 0.25,
        seed: int = 0,
    ) -> Dict[str, Any]:
        """Train the student on (trajectory, 64x64 viewport, label) batches as model(trajs, visual).

        The visual tensor is zeroed for a fraction of training samples so the all-zero tensor the
        extension feeds when no frame is available stays in-distribution.
        """
        hp = config.get("hyperparameters", {})
        epochs = hp.get("epochs", 5)
        batch_size = hp.get("batch_size", 32)
        lr = hp.get("learning_rate", 1e-3)
        weight_decay = hp.get("weight_decay", 1e-4)
        patience = hp.get("early_stopping_patience", 0)
        seq_len = config.get("seq_length", 128)

        train_loader, val_loader = create_visual_student_loaders(
            num_samples=num_samples, seq_length=seq_len, batch_size=batch_size, seed=seed
        )

        torch.manual_seed(seed)
        model = DistilledStudentModel(
            behavioral_in_channels=config.get("behavioral_in_channels", 6),
            behavioral_dim=config.get("behavioral_dim", 64),
            include_visual=True,
        ).to(self.device)

        optimizer = optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
        criterion = nn.BCELoss()

        best_val_loss = float("inf")
        best_checkpoint_path: Optional[Path] = None
        stale_epochs = 0
        history: List[Dict[str, float]] = []

        for ep in range(epochs):
            model.train()
            train_loss = 0.0
            for trajs, visual, labels in train_loader:
                trajs, visual, labels = trajs.to(self.device), visual.to(self.device), labels.to(self.device)
                keep = (torch.rand(visual.size(0), 1, 1, 1, device=self.device) >= visual_dropout).float()
                optimizer.zero_grad()
                loss = criterion(model(trajs, visual * keep), labels)
                loss.backward()
                optimizer.step()
                train_loss += loss.item() * len(labels)
            train_loss /= len(train_loader.dataset)

            model.eval()
            val_loss = 0.0
            correct = 0
            total = 0
            with torch.no_grad():
                for trajs, visual, labels in val_loader:
                    trajs, visual, labels = trajs.to(self.device), visual.to(self.device), labels.to(self.device)
                    preds = model(trajs, visual)
                    val_loss += criterion(preds, labels).item() * len(labels)
                    correct += ((preds >= 0.5).float() == labels).sum().item()
                    total += len(labels)
            val_loss /= len(val_loader.dataset)
            accuracy = correct / max(total, 1)

            epoch_metrics = {
                "train_loss": round(train_loss, 4),
                "val_loss": round(val_loss, 4),
                "val_accuracy": round(accuracy, 4),
            }
            history.append(epoch_metrics)
            print(f"[PhishGuard-ML] epoch {ep + 1}/{epochs} {epoch_metrics}")

            improved = val_loss < best_val_loss
            if checkpoint_every_epoch or improved:
                chk_path = self.checkpoint_manager.save_raw_checkpoint(
                    model=model,
                    optimizer=optimizer,
                    epoch=ep + 1,
                    step=(ep + 1) * len(train_loader),
                    loss=val_loss,
                    metrics=epoch_metrics,
                    config=config,
                )
                if improved:
                    best_val_loss = val_loss
                    best_checkpoint_path = chk_path
            stale_epochs = 0 if improved else stale_epochs + 1
            if patience and stale_epochs >= patience:
                break

        return {
            "model": model,
            "best_val_loss": best_val_loss,
            "best_checkpoint_path": str(best_checkpoint_path) if best_checkpoint_path else None,
            "history": history,
            "epochs_completed": len(history),
        }

    def train_distillation(
        self,
        teacher: Optional[TeacherMultimodalModel] = None,
        config: Optional[Dict[str, Any]] = None,
        num_samples: int = 128,
        temperature: float = 2.0,
        alpha: float = 0.5,
    ) -> Dict[str, Any]:
        """Execute teacher-student knowledge distillation with soft-label KL divergence."""
        cfg = config or {}
        hp = cfg.get("hyperparameters", {})
        epochs = hp.get("epochs", 5)
        batch_size = hp.get("batch_size", 16)
        lr = hp.get("learning_rate", 1e-3)
        seq_len = cfg.get("seq_length", 128)

        # Initialize teacher if not provided
        if teacher is None:
            raise ValueError("Distillation requires an explicitly trained, validated teacher")
        teacher.eval()

        student = DistilledStudentModel(
            behavioral_in_channels=6,
            behavioral_dim=64,
            include_visual=False,
        ).to(self.device)

        train_loader, val_loader = self.generate_synthetic_dataset(
            num_samples=num_samples, seq_length=seq_len, batch_size=batch_size
        )

        optimizer = optim.AdamW(student.parameters(), lr=lr)
        bce_criterion = nn.BCELoss()
        kl_criterion = nn.KLDivLoss(reduction="batchmean")

        best_loss = float("inf")
        best_checkpoint: Optional[torch.Path] = None

        for ep in range(epochs):
            student.train()
            ep_loss = 0.0

            for trajs, labels in train_loader:
                trajs = trajs.to(self.device)
                labels = labels.to(self.device).float()

                # Teacher soft predictions
                with torch.no_grad():
                    dummy_vision = torch.zeros(trajs.size(0), teacher.vision_dim, device=self.device)
                    dummy_dom = torch.zeros(trajs.size(0), teacher.dom_dim, device=self.device)
                    teacher_preds, _ = teacher(trajs, dummy_vision, dummy_dom)

                optimizer.zero_grad()
                student_preds = student(trajs)

                hard_loss = bce_criterion(student_preds, labels)

                # Soft KL loss on scaled probabilities
                s_soft = torch.stack([student_preds / temperature, (1 - student_preds) / temperature], dim=-1).log()
                t_soft = torch.stack([teacher_preds / temperature, (1 - teacher_preds) / temperature], dim=-1)
                soft_loss = kl_criterion(s_soft, t_soft) * (temperature ** 2)

                total_loss = alpha * hard_loss + (1.0 - alpha) * soft_loss
                total_loss.backward()
                optimizer.step()

                ep_loss += total_loss.item() * len(labels)

            ep_loss /= len(train_loader.dataset)

            chk_path = self.checkpoint_manager.save_raw_checkpoint(
                model=student,
                optimizer=optimizer,
                epoch=ep + 1,
                step=(ep + 1) * len(train_loader),
                loss=ep_loss,
                metrics={"distillation_loss": round(ep_loss, 4)},
                config=cfg,
            )
            if ep_loss < best_loss:
                best_loss = ep_loss
                best_checkpoint = chk_path

        return {
            "student_model": student,
            "best_loss": best_loss,
            "best_checkpoint_path": str(best_checkpoint) if best_checkpoint else None,
        }

    def extract_and_store_dataset(
        self,
        output_dir: Union[str, Path],
        num_samples: int = 1000,
        split_ratios: Tuple[float, float, float] = (0.70, 0.15, 0.15),
        save_images: bool = True,
        seed: int = 42,
        benchmark: str = "synthetic",
    ) -> DatasetManifest:
        """Extract and store a comprehensive multimodal dataset to disk."""
        if benchmark == "industrial":
            return self.extract_and_store_industrial_benchmark(
                output_dir=output_dir,
                num_samples=num_samples,
                split_ratios=split_ratios,
                save_images=save_images,
                seed=seed,
            )

        samples = generate_multimodal_dataset_batch(
            num_samples=num_samples,
            phishing_ratio=0.5,
            seq_length=64,
            seed=seed,
        )
        manifest = store_multimodal_dataset(
            output_dir=output_dir,
            samples=samples,
            split_ratios=split_ratios,
            save_images=save_images,
            seq_length=64,
        )
        return manifest

    def extract_and_store_industrial_benchmark(
        self,
        output_dir: Union[str, Path],
        num_samples: int = 300,
        split_ratios: Tuple[float, float, float] = (0.70, 0.15, 0.15),
        save_images: bool = True,
        seed: int = 42,
    ) -> DatasetManifest:
        """Extract and store industrial benchmark dataset (PhishTank/OpenPhish + Tranco + Phishpedia brands)."""
        samples = build_industrial_benchmark_dataset(
            num_samples=num_samples,
            phishing_ratio=0.5,
            seq_length=64,
            seed=seed,
        )
        manifest = store_multimodal_dataset(
            output_dir=output_dir,
            samples=samples,
            dataset_name="phishguard-industrial-benchmark",
            dataset_version="1.0.0",
            split_ratios=split_ratios,
            save_images=save_images,
            seq_length=64,
        )
        return manifest

    def train_sota_multimodal(
        self,
        dataset_dir: Union[str, Path],
        config: Optional[Dict[str, Any]] = None,
        epochs: int = 15,
        batch_size: int = 16,
        lr: float = 8e-4,
    ) -> Dict[str, Any]:
        """Train PhishGuardSOTAMultimodalModel on stored multimodal dataset."""
        cfg = config or {}
        hp = cfg.get("hyperparameters", {})
        epochs = hp.get("epochs", epochs)
        batch_size = hp.get("batch_size", batch_size)
        lr = hp.get("learning_rate", lr)

        train_loader = create_sota_multimodal_dataloader(
            dataset_dir, split="train", batch_size=batch_size, shuffle=True, augment=True
        )
        val_loader = create_sota_multimodal_dataloader(
            dataset_dir, split="val", batch_size=batch_size, shuffle=False, augment=False
        )

        model = PhishGuardSOTAMultimodalModel(
            vision_dim=64,
            dynamics_dim=36,
            url_dim=24,
            hid_dim=16,
            logo_dim=16,
            detection_dim=16,
            hidden_dim=64,
            dropout_p=0.2,
        ).to(self.device)

        training_results = train_sota_multimodal_model(
            model=model,
            train_loader=train_loader,
            val_loader=val_loader,
            epochs=epochs,
            warmup_epochs=max(1, epochs // 5),
            lr=lr,
            device=self.device,
        )

        # Evaluate on test split if available
        test_metrics = {}
        passed_sota = False
        try:
            test_loader = create_sota_multimodal_dataloader(
                dataset_dir, split="test", batch_size=batch_size, shuffle=False, augment=False
            )
            criterion = FocalBrierCalibrationLoss(alpha=0.65, gamma=2.0, brier_lambda=0.1)
            test_metrics = evaluate_sota_epoch(model, test_loader, criterion, self.device)

            passed_sota = (
                test_metrics["val_accuracy"] >= SOTA_BENCHMARK_TARGETS["min_accuracy"]
                and test_metrics["val_f1"] >= SOTA_BENCHMARK_TARGETS["min_f1"]
                and test_metrics["val_fpr"] <= SOTA_BENCHMARK_TARGETS["max_fpr"]
            )
        except Exception:
            pass

        # Persist checkpoint
        best_chk = self.checkpoint_manager.save_raw_checkpoint(
            model=model,
            optimizer=None,
            epoch=epochs,
            step=epochs * len(train_loader),
            loss=training_results["best_val_loss"],
            metrics={**training_results["final_metrics"], **test_metrics},
            config={
                **cfg,
                "model_name": "phishguard-sota-multimodal",
                "architecture": "PhishGuardSOTAMultimodalModel",
                "passed_sota": passed_sota,
            },
        )

        return {
            "model": model,
            "training_results": training_results,
            "best_checkpoint_path": str(best_chk),
            "test_metrics": test_metrics,
            "passed_sota": passed_sota,
        }
