"""Model architectures for PhishGuard."""

from .behavioral_cnn_lstm import BehavioralCNNLSTM
from .student_model import DistilledStudentModel
from .teacher_multimodal import TeacherMultimodalModel

__all__ = [
    "BehavioralCNNLSTM",
    "DistilledStudentModel",
    "TeacherMultimodalModel",
]
