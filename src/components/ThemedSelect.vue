<script setup lang="ts">
import { ref, computed, onBeforeUnmount, nextTick } from 'vue'

export interface SelectOption {
  value: string
  label: string
}

const props = withDefaults(
  defineProps<{
    options: SelectOption[]
    modelValue: string
    placeholder?: string
    disabled?: boolean
    /** 是否允许清空 */
    clearable?: boolean
    clearLabel?: string
  }>(),
  {
    placeholder: '请选择',
    disabled: false,
    clearable: false,
    clearLabel: '不限',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
/** 下拉菜单向上展开（当触发器靠近视口底部时） */
const dropUp = ref(false)

const selected = computed(() => props.options.find((o) => o.value === props.modelValue))

const displayText = computed(() => {
  if (!props.modelValue && props.clearable) return props.clearLabel
  return selected.value?.label || props.placeholder
})

function toggle() {
  if (props.disabled) return
  if (open.value) {
    close()
  } else {
    openMenu()
  }
}

async function openMenu() {
  open.value = true
  await nextTick()
  updateDirection()
  document.addEventListener('click', onDocClick)
}

function close() {
  open.value = false
  document.removeEventListener('click', onDocClick)
}

/** 根据触发器在视口的位置决定向上还是向下展开 */
function updateDirection() {
  if (!rootRef.value) return
  const rect = rootRef.value.getBoundingClientRect()
  // 视口高度 - 触发器底部 < 280px 时，向上展开
  dropUp.value = window.innerHeight - rect.bottom < 280 && rect.top > 280
}

function onDocClick(e: MouseEvent) {
  const target = e.target as Node
  if (rootRef.value && !rootRef.value.contains(target)) {
    close()
  }
}

function pick(o: SelectOption | null) {
  const val = o ? o.value : ''
  emit('update:modelValue', val)
  emit('change', val)
  close()
}

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div ref="rootRef" :class="['ts', disabled && 'ts--disabled']">
    <button
      class="ts__trigger"
      :class="{ 'ts__trigger--placeholder': !modelValue && !clearable, 'ts__trigger--open': open }"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="ts__text">{{ displayText }}</span>
      <van-icon :name="open ? 'arrow-up' : 'arrow-down'" size="12" class="ts__arrow" />
    </button>

    <transition name="ts-drop">
      <div v-if="open" ref="menuRef" :class="['ts__menu', dropUp && 'ts__menu--up']">
        <div class="ts__menu-scroll">
          <div
            v-if="clearable"
            :class="['ts__option', !modelValue && 'ts__option--active']"
            @click="pick(null)"
          >
            <span>{{ clearLabel }}</span>
            <van-icon v-if="!modelValue" name="success" size="14" color="var(--brand)" />
          </div>
          <div
            v-for="o in options"
            :key="o.value"
            :class="['ts__option', modelValue === o.value && 'ts__option--active']"
            @click="pick(o)"
          >
            <span>{{ o.label }}</span>
            <van-icon v-if="modelValue === o.value" name="success" size="14" color="var(--brand)" />
          </div>
          <!-- 空状态：无可选项（且非 clearable 的「不限」） -->
          <div v-if="!options.length && !clearable" class="ts__empty">暂无可选项</div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.ts {
  position: relative;
  width: 100%;
}
.ts--disabled {
  opacity: 0.5;
}

/* ===== 触发器 ===== */
.ts__trigger {
  width: 100%;
  height: 42px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  transition: border-color 0.15s;
}
.ts__trigger:hover,
.ts__trigger--open {
  border-color: var(--brand);
}
.ts__trigger:disabled {
  cursor: not-allowed;
}
.ts__trigger--placeholder .ts__text {
  color: var(--text-3);
}
.ts__text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts__arrow {
  color: var(--text-3);
  flex-shrink: 0;
  transition: transform 0.2s;
}

/* ===== 下拉菜单（绝对定位，从触发器下方/上方展开） ===== */
.ts__menu {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  z-index: 100;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-md);
  overflow: hidden;
}
.ts__menu--up {
  top: auto;
  bottom: calc(100% + 4px);
}
.ts__menu-scroll {
  max-height: 240px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 0;
}
.ts__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-size: 14px;
  color: var(--text);
  cursor: pointer;
  transition: background 0.1s;
}
.ts__option:hover {
  background: var(--surface-2);
}
.ts__option--active {
  color: var(--brand);
  font-weight: 600;
  background: var(--brand-soft);
}
.ts__empty {
  padding: var(--sp-4) var(--sp-3);
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}

/* ===== 展开动画 ===== */
.ts-drop-enter-active,
.ts-drop-leave-active {
  transition:
    opacity 0.15s,
    transform 0.15s;
}
.ts-drop-enter-from,
.ts-drop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.ts__menu--up.ts-drop-enter-from,
.ts__menu--up.ts-drop-leave-to {
  transform: translateY(4px);
}
</style>
