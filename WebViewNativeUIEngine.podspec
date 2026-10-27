require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
Pod::Spec.new do |s|
 s.name = 'WebViewNativeUIEngine'
 s.version = package['version']
 s.summary = 'Native UI infrastructure for Capacitor and Cordova plugin maintainers.'
 s.homepage = 'https://github.com/webview-native-ui/engine'
 s.license = { :type => 'Zlib', :file => 'LICENSE' }
 s.preserve_paths = 'LICENSE', 'NOTICE'
 s.author = { 'rdlabo' => 'sakakibara@rdlabo.jp' }
 s.source = { :git => 'https://github.com/webview-native-ui/engine.git', :tag => "v#{s.version}" }
 s.resource_bundles = { 'WebViewNativeUIEngine' => ['ios/Sources/WebViewNativeUIEngine/Resources/*.js'] }
 s.source_files = 'ios/Sources/WebViewNativeUIEngine/**/*.swift'
 s.ios.deployment_target = '15.0'
 s.swift_version = '5.9'
 s.frameworks = 'UIKit', 'WebKit'
end
