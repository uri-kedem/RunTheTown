# Adds RunTheTown's own native pieces to the Xcode project (ios/App/App.xcodeproj):
# the in-app plugins (Health, Chime, Live Activity) and the view controller that registers
# them, the HealthKit entitlement, the Info.plist texts iOS shows when it asks permission,
# and the RunActivity widget extension that draws the run on the Lock Screen.
# Safe to run again: everything is added only when missing. Run through
# `node native/configure-ios.mjs` (which also knows where CocoaPods' Ruby keeps xcodeproj).
require 'xcodeproj'

root = File.expand_path('../ios/App', __dir__)
project = Xcodeproj::Project.open(File.join(root, 'App.xcodeproj'))
app = project.targets.find { |t| t.name == 'App' } or abort 'App target not found'
team = app.build_configurations.first.build_settings['DEVELOPMENT_TEAM']
app_group = project.main_group['App'] or abort 'App group not found'

def add_file(group, target, path, root)
  rel = path.sub(%r{^#{Regexp.escape(root)}/?}, '')
  ref = group.files.find { |f| f.real_path.to_s == path } || group.new_file(path)
  unless target.source_build_phase.files_references.include?(ref)
    target.add_file_references([ref])
    puts "added #{rel} to #{target.name}"
  end
  ref
end

# ---- the app's own plugins ----
plugins = app_group['Plugins'] || app_group.new_group('Plugins', 'Plugins')
add_file(app_group, app, File.join(root, 'App/RTTViewController.swift'), root)
add_file(app_group, app, File.join(root, 'App/SceneDelegate.swift'), root)
%w[HealthPlugin ChimePlugin LiveActivityPlugin RunActivityAttributes].each do |name|
  add_file(plugins, app, File.join(root, "App/Plugins/#{name}.swift"), root)
end

# ---- HealthKit entitlement ----
ent_path = File.join(root, 'App/App.entitlements')
unless File.exist?(ent_path)
  File.write(ent_path, <<~XML)
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
    \t<key>com.apple.developer.healthkit</key>
    \t<true/>
    \t<key>com.apple.developer.healthkit.access</key>
    \t<array/>
    </dict>
    </plist>
  XML
  puts 'wrote App/App.entitlements'
end
app_group.files.find { |f| f.path == 'App.entitlements' } || app_group.new_file(ent_path)
app.build_configurations.each do |c|
  c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
end
attrs = project.root_object.attributes['TargetAttributes'] ||= {}
(attrs[app.uuid] ||= {})['SystemCapabilities'] = { 'com.apple.HealthKit' => { 'enabled' => 1 } }

# ---- the RunActivity widget extension (Lock Screen + Dynamic Island) ----
ext = project.targets.find { |t| t.name == 'RunActivity' }
unless ext
  ext = project.new_target(:app_extension, 'RunActivity', :ios, '16.1')
  ext_group = project.main_group.new_group('RunActivity', 'RunActivity')
  ext.add_file_references([ext_group.new_file(File.join(root, 'RunActivity/RunActivityWidget.swift'))])
  # The state type is compiled into both the app and the extension.
  shared = plugins.files.find { |f| f.path == 'RunActivityAttributes.swift' }
  ext.add_file_references([shared])
  ext_group.new_file(File.join(root, 'RunActivity/Info.plist'))
  ext.build_configurations.each do |c|
    c.build_settings['INFOPLIST_FILE'] = 'RunActivity/Info.plist'
    c.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.urikedem.runthetown.RunActivity'
    c.build_settings['PRODUCT_NAME'] = 'RunActivity'
    c.build_settings['INFOPLIST_KEY_CFBundleDisplayName'] = 'RunTheTown'
    c.build_settings['INFOPLIST_KEY_NSHumanReadableCopyright'] = ''
    c.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
    c.build_settings['MARKETING_VERSION'] = '1.0'
    c.build_settings['CURRENT_PROJECT_VERSION'] = '1'
    c.build_settings['SWIFT_VERSION'] = '5.0'
    c.build_settings['TARGETED_DEVICE_FAMILY'] = '1'
    c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.1'
    c.build_settings['CODE_SIGN_STYLE'] = 'Automatic'
    c.build_settings['DEVELOPMENT_TEAM'] = team if team
    c.build_settings['SKIP_INSTALL'] = 'YES'
    c.build_settings['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
    c.build_settings['ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME'] = 'AccentColor'
    c.build_settings['ASSETCATALOG_COMPILER_WIDGET_BACKGROUND_COLOR_NAME'] = 'WidgetBackground'
  end
  %w[WidgetKit SwiftUI].each { |fw| ext.add_system_framework(fw) }
  app.add_dependency(ext)
  embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
  embed.symbol_dst_subfolder_spec = :plug_ins
  embed.add_file_reference(ext.product_reference).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  puts 'added the RunActivity extension target'
end

project.save
puts 'project saved'
