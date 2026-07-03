/**
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import { PluginManager } from 'sn-plugin-lib';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// Sidebar entry point, notes only: opens the cloze quiz view for the
// currently open note page.
PluginManager.registerButton(1, ['NOTE'], {
  id: 100,
  name: 'Cloze',
  icon: Image.resolveAssetSource(
    require('./assets/icon.png'),
  ).uri,
  showType: 1,
});
