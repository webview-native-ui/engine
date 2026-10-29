const capacitor = require('@ionic/swiftlint-config');

module.exports = {
  ...capacitor,
  included: ['${PWD}/ios/Sources', '${PWD}/ios/Tests', '${PWD}/tests/cordova/plugin/src/ios'],
  // unused_import requires a compiler log and swiftlint analyze, not lint.
  opt_in_rules: capacitor.opt_in_rules.filter((rule) => rule !== 'unused_import'),
  disabled_rules: [
    // Review state-machine structure rather than forcing splits at arbitrary counts.
    'function_body_length',
    'type_body_length',
    'cyclomatic_complexity',
    // Keep existing public argument order, nested API types and geometry tuples.
    'function_default_parameter_at_end',
    'nesting',
    'large_tuple',
    // Completion handlers remain trailing closures, matching UIKit call sites.
    'multiple_closures_with_trailing_closure',
  ],
  identifier_name: { excluded: ['id', 'x', 'y', 'w', 'h', 'to'] },
};
