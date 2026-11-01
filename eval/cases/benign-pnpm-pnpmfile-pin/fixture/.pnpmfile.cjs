// SYNTHETIC croak eval fixture (croak-eval-synthetic): pins a transitive dependency.
function readPackage(pkg) {
  if (pkg.dependencies?.lodash) pkg.dependencies.lodash = "4.17.21";
  return pkg;
}

module.exports = { hooks: { readPackage } };
