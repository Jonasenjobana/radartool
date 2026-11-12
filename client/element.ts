import type { App } from 'vue';
import { ElAlert, ElButton, ElButtonGroup, ElCheckbox, ElCheckboxGroup, ElCollapse, ElCollapseItem, ElConfigProvider, ElDatePicker, ElDescriptions, ElDescriptionsItem, ElDialog, ElDivider, ElDrawer, ElDropdown, ElDropdownItem, ElDropdownMenu, ElEmpty, ElForm, ElFormItem, ElIcon, ElInput, ElInputNumber, ElOption, ElPopconfirm, ElProgress, ElRadioButton, ElRadioGroup, ElScrollbar, ElSelect, ElSlider, ElSwitch, ElTable, ElTableColumn, ElTabPane, ElTabs, ElTag } from 'element-plus';
import 'element-plus/dist/index.css';

const components = [ElAlert, ElButton, ElButtonGroup, ElCheckbox, ElCheckboxGroup, ElCollapse, ElCollapseItem, ElConfigProvider, ElDatePicker, ElDescriptions, ElDescriptionsItem, ElDialog, ElDivider, ElDrawer, ElDropdown, ElDropdownItem, ElDropdownMenu, ElEmpty, ElForm, ElFormItem, ElIcon, ElInput, ElInputNumber, ElOption, ElPopconfirm, ElProgress, ElRadioButton, ElRadioGroup, ElScrollbar, ElSelect, ElSlider, ElSwitch, ElTable, ElTableColumn, ElTabPane, ElTabs, ElTag];
export function installElement(app: App) { for (const component of components) app.component(component.name!, component); }
