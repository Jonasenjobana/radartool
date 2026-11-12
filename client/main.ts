import { createApp } from 'vue';
import { installElement } from './element';
import 'leaflet/dist/leaflet.css';
import './style.css';
import App from './App.vue';

createApp(App).use(installElement).mount('#app');
