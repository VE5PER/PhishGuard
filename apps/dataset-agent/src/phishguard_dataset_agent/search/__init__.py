"""Search package for web-based dataset discovery."""

from .models import SearchQuery, SearchResultItem, WebSearchBatch
from .query_generator import DatasetQueryGenerator
from .providers import (
    BaseSearchProvider,
    MockSearchProvider,
    DuckDuckGoSearchProvider,
    SerpApiSearchProvider,
    CompositeSearchProvider,
)

__all__ = [
    "SearchQuery",
    "SearchResultItem",
    "WebSearchBatch",
    "DatasetQueryGenerator",
    "BaseSearchProvider",
    "MockSearchProvider",
    "DuckDuckGoSearchProvider",
    "SerpApiSearchProvider",
    "CompositeSearchProvider",
]
