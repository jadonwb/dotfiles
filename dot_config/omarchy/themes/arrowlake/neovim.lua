return {
  {
    'jadonwb/arrowlake.nvim',
    opts = {
      transparent = false,
      styles = {
        sidebars = 'transparent',
        floats = 'transparent',
        popups = 'transparent',
        statusline = 'transparent',
      },
      lualine_bold = true,
      dim_inactive = false,
    },
  },
  {
    'LazyVim/LazyVim',
    opts = {
      colorscheme = 'arrowlake-darker',
    },
  },
}
