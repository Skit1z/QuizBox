<script setup lang="ts">
import { ref, computed } from 'vue'
import type { PopoverPlacement } from 'vant'

export interface PopoverAction {
  text: string
  icon?: string
  color?: string
  className?: string
  callback?: () => void
}

const props = withDefaults(
  defineProps<{
    /** 是否受控显示 */
    show?: boolean
    /** 操作选项配置列表 */
    actions: PopoverAction[]
    /** 是否禁用弹出（例如未通过密码鉴权时） */
    disabled?: boolean
    /** 气泡框弹出位置 */
    placement?: PopoverPlacement
  }>(),
  {
    show: undefined,
    disabled: false,
    placement: 'bottom-end',
  },
)

const emit = defineEmits<{
  'update:show': [val: boolean]
  /** 当处于禁用状态下被点击时触发（例如触发父组件的鉴权弹窗） */
  'click-disabled': []
  /** 选择任意选项时触发 */
  select: [action: PopoverAction]
}>()

const innerShow = ref(false)
const isControlled = computed(() => props.show !== undefined)

const showPopover = computed({
  get() {
    return isControlled.value ? !!props.show : innerShow.value
  },
  set(val) {
    if (isControlled.value) {
      emit('update:show', val)
    } else {
      innerShow.value = val
    }
  },
})

function onReferenceClick(e: Event) {
  if (props.disabled) {
    // 拦截点击事件以防止默认的 Popover 呼出，交由父组件鉴权
    e.stopPropagation()
    emit('click-disabled')
  }
}

function onSelect(action: PopoverAction) {
  showPopover.value = false
  emit('select', action)
  if (action.callback) {
    action.callback()
  }
}
</script>

<template>
  <!-- 
    复用组件说明 (ActionPopover):
    此组件封装了 Vant Popover，并集成了卡片操作菜单常用的“密码鉴权”和“点击空白自动关闭”逻辑。
    
    使用示例:
    <ActionPopover
      v-model:show="showPopoverMap[item.id]"
      :actions="[
        { text: '编辑', icon: 'edit', callback: () => openEdit(item) },
        { text: '删除', icon: 'delete-o', className: 'popover-danger-action', callback: () => remove(item.id) }
      ]"
      :disabled="!adminStore.canOperate()"
      @click-disabled="guardedAction(() => { showPopoverMap[item.id] = true })"
    >
      <button class="menu-btn"><van-icon name="ellipsis" /></button>
    </ActionPopover>
  -->
  <van-popover
    v-model:show="showPopover"
    :actions="actions"
    :placement="placement"
    @select="onSelect"
  >
    <template #reference>
      <div @click="onReferenceClick" style="display: inline-flex">
        <slot></slot>
      </div>
    </template>
  </van-popover>
</template>

<style scoped>
/* 组件包裹 div 确保不破坏 reference 按钮布局 */
div {
  vertical-align: middle;
}
</style>
