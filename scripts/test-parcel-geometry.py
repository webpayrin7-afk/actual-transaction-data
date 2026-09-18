"""Geometry / CRS checks that do not need the cadastral SHP."""
from pyproj import Transformer
from shapely.geometry import Polygon


def test_representative_point_inside() -> None:
    poly = Polygon([(0, 0), (4, 0), (4, 2), (0, 2), (0, 0)])
    pt = poly.representative_point()
    assert poly.covers(pt)
    # crescent-like ring where centroid can fall outside
    c = Polygon([(0, 0), (6, 0), (6, 1), (1, 1), (1, 5), (0, 5), (0, 0)])
    rp = c.representative_point()
    assert c.covers(rp)


def test_wgs84_axis_order_roundtrip() -> None:
    fwd = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True)
    inv = Transformer.from_crs("EPSG:5186", "EPSG:4326", always_xy=True)
    lng, lat = 127.0815962, 37.5133051
    x, y = fwd.transform(lng, lat)
    lng2, lat2 = inv.transform(x, y)
    assert abs(lng2 - lng) < 1e-6
    assert abs(lat2 - lat) < 1e-6
    assert 37.4 < lat2 < 37.7
    assert 126.9 < lng2 < 127.2


if __name__ == "__main__":
    test_representative_point_inside()
    test_wgs84_axis_order_roundtrip()
    print("test-parcel-geometry: PASS")
