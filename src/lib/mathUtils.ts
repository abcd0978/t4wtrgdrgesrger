/** Pure math for gaussian covariances + rotations (no three/DOM deps).
 * Covariance is always the symmetric upper-triangle [Σ00,Σ01,Σ02,Σ11,Σ12,Σ22].
 *
 *   scale + rotation  --covarianceFromScaleRotation-->  covariance
 *   covariance        --covarianceToScaleRotation-->    scale + rotation
 */

/** Upper-tri covariance from full (N,3,3) covariance matrices. */
export function covarianceUpperTriFromMatrix(cov: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * 6);
  const idx = [0, 1, 2, 4, 5, 8];
  for (let i = 0; i < n; i++) for (let k = 0; k < 6; k++) out[i * 6 + k] = cov[i * 9 + idx[k]];
  return out;
}

/** Σ = R diag(s²) Rᵀ upper-tri, from per-gaussian scale (s) and quaternion (wxyz). */
export function covarianceFromScaleRotation(scales: Float32Array, wxyz: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const sx = scales[i * 3], sy = scales[i * 3 + 1], sz = scales[i * 3 + 2];
    let w = wxyz[i * 4], x = wxyz[i * 4 + 1], y = wxyz[i * 4 + 2], z = wxyz[i * 4 + 3];
    const nrm = Math.hypot(w, x, y, z) || 1e-12;
    w /= nrm; x /= nrm; y /= nrm; z /= nrm;
    const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
    const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
    const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
    const dx = sx * sx, dy = sy * sy, dz = sz * sz;
    out[i * 6 + 0] = r00 * r00 * dx + r01 * r01 * dy + r02 * r02 * dz; // 00
    out[i * 6 + 1] = r00 * r10 * dx + r01 * r11 * dy + r02 * r12 * dz; // 01
    out[i * 6 + 2] = r00 * r20 * dx + r01 * r21 * dy + r02 * r22 * dz; // 02
    out[i * 6 + 3] = r10 * r10 * dx + r11 * r11 * dy + r12 * r12 * dz; // 11
    out[i * 6 + 4] = r10 * r20 * dx + r11 * r21 * dy + r12 * r22 * dz; // 12
    out[i * 6 + 5] = r20 * r20 * dx + r21 * r21 * dy + r22 * r22 * dz; // 22
  }
  return out;
}

/** Jacobi eigendecomposition of a symmetric 3x3 given as upper-tri
 * [a00,a01,a02,a11,a12,a22]. eigenvectors is row-major 3x3 with eigenvectors as
 * COLUMNS, so the input = eigenvectors · diag(eigenvalues) · eigenvectorsᵀ. */
export function eigenDecomposeSymmetric3(upperTri: number[]): {
  eigenvalues: number[];
  eigenvectors: number[];
} {
  const a = [
    [upperTri[0], upperTri[1], upperTri[2]],
    [upperTri[1], upperTri[3], upperTri[4]],
    [upperTri[2], upperTri[4], upperTri[5]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    if (Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]) < 1e-14) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const phi = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
      const c = Math.cos(phi), sn = Math.sin(phi);
      for (let k = 0; k < 3; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - sn * kq; a[k][q] = sn * kp + c * kq; }
      for (let k = 0; k < 3; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - sn * qk; a[q][k] = sn * pk + c * qk; }
      for (let k = 0; k < 3; k++) { const kp = v[k][p], kq = v[k][q]; v[k][p] = c * kp - sn * kq; v[k][q] = sn * kp + c * kq; }
    }
  }
  return {
    eigenvalues: [a[0][0], a[1][1], a[2][2]],
    eigenvectors: [v[0][0], v[0][1], v[0][2], v[1][0], v[1][1], v[1][2], v[2][0], v[2][1], v[2][2]],
  };
}

/** Rotation matrix (row-major 3x3) -> quaternion wxyz (3DGS rot_0..3 order). */
export function rotationMatrixToQuaternion(m: number[]): [number, number, number, number] {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const S = Math.sqrt(tr + 1) * 2;
    return [0.25 * S, (m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S];
  } else if (m00 > m11 && m00 > m22) {
    const S = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [(m21 - m12) / S, 0.25 * S, (m01 + m10) / S, (m02 + m20) / S];
  } else if (m11 > m22) {
    const S = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m02 - m20) / S, (m01 + m10) / S, 0.25 * S, (m12 + m21) / S];
  }
  const S = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m10 - m01) / S, (m02 + m20) / S, (m12 + m21) / S, 0.25 * S];
}

/** Covariance (upper-tri) -> per-axis scale + quaternion wxyz. */
export function covarianceToScaleRotation(cov6: number[]): {
  scale: [number, number, number];
  quaternion: [number, number, number, number];
} {
  const { eigenvalues, eigenvectors } = eigenDecomposeSymmetric3(cov6);
  const scale: [number, number, number] = [
    Math.sqrt(Math.max(eigenvalues[0], 0)),
    Math.sqrt(Math.max(eigenvalues[1], 0)),
    Math.sqrt(Math.max(eigenvalues[2], 0)),
  ];
  // eigenvectors as columns = rotation; flip a column if it's left-handed.
  let r = eigenvectors;
  const det =
    r[0] * (r[4] * r[8] - r[5] * r[7]) -
    r[1] * (r[3] * r[8] - r[5] * r[6]) +
    r[2] * (r[3] * r[7] - r[4] * r[6]);
  if (det < 0) r = [-r[0], r[1], r[2], -r[3], r[4], r[5], -r[6], r[7], r[8]];
  return { scale, quaternion: rotationMatrixToQuaternion(r) };
}
