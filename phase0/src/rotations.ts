import * as THREE from 'three';

// The 24 right-angle rotational symmetries of a cube.
//
// Generated as: each of 6 face directions becomes the new "up", then 4 spins
// around that new-up axis. May contain a small number of redundant entries
// for antipodal up cases; the quantizer is unaffected — it picks the best
// score over whatever the list contains.
export function buildCubeRotations(): THREE.Quaternion[] {
  const out: THREE.Quaternion[] = [];
  const baseUp = new THREE.Vector3(0, 1, 0);

  const upDirs: THREE.Vector3[] = [
    new THREE.Vector3(0,  1,  0),
    new THREE.Vector3(0, -1,  0),
    new THREE.Vector3(1,  0,  0),
    new THREE.Vector3(-1, 0,  0),
    new THREE.Vector3(0,  0,  1),
    new THREE.Vector3(0,  0, -1),
  ];

  for (const newUp of upDirs) {
    const qAlign = new THREE.Quaternion().setFromUnitVectors(baseUp, newUp);
    for (let i = 0; i < 4; i++) {
      const qSpin = new THREE.Quaternion().setFromAxisAngle(newUp, (Math.PI / 2) * i);
      const q = new THREE.Quaternion().multiplyQuaternions(qSpin, qAlign);
      out.push(q);
    }
  }

  return out;
}
