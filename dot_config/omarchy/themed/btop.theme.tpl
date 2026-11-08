# Arrowlake btop theme, rendered by Omarchy from the theme's colors.toml.
# Main background, empty for terminal default, need to be empty if you want transparent background
theme[main_bg]="{{ background }}"

# Main text color
theme[main_fg]="{{ foreground }}"

# Title color for boxes
theme[title]="{{ foreground }}"

# Highlight color for keyboard shortcuts
theme[hi_fg]="{{ orange }}"

# Background color of selected item in processes box
theme[selected_bg]="{{ selection }}"

# Foreground color of selected item in processes box
theme[selected_fg]="{{ cyan }}"

# Color of inactive/disabled text
theme[inactive_fg]="{{ muted }}"

# Color of text appearing on top of graphs, i.e uptime and current network graph scaling
theme[graph_text]="{{ light_foreground }}"

# Background color of the percentage meters
theme[meter_bg]="{{ selection }}"

# Misc colors for processes box including mini cpu graphs, details memory graph and details status text
theme[proc_misc]="{{ cyan }}"

# CPU, Memory, Network, Proc box outline colors
theme[cpu_box]="{{ accent }}"
theme[mem_box]="{{ accent }}"
theme[net_box]="{{ accent }}"
theme[proc_box]="{{ accent }}"

# Box divider line and small boxes line color
theme[div_line]="{{ accent }}"

# Temperature graph color (Green -> Yellow -> Red)
theme[temp_start]="{{ green }}"
theme[temp_mid]="{{ yellow }}"
theme[temp_end]="{{ red }}"

# CPU graph colors (Green -> Yellow -> Red)
theme[cpu_start]="{{ green }}"
theme[cpu_mid]="{{ yellow }}"
theme[cpu_end]="{{ red }}"

# Mem/Disk free meter
theme[free_start]="{{ green }}"
theme[free_mid]="{{ yellow }}"
theme[free_end]="{{ red }}"

# Mem/Disk cached meter
theme[cached_start]="{{ green }}"
theme[cached_mid]="{{ yellow }}"
theme[cached_end]="{{ red }}"

# Mem/Disk available meter
theme[available_start]="{{ green }}"
theme[available_mid]="{{ yellow }}"
theme[available_end]="{{ red }}"

# Mem/Disk used meter
theme[used_start]="{{ green }}"
theme[used_mid]="{{ yellow }}"
theme[used_end]="{{ red }}"

# Download graph colors
theme[download_start]="{{ green }}"
theme[download_mid]="{{ yellow }}"
theme[download_end]="{{ red }}"

# Upload graph colors
theme[upload_start]="{{ green }}"
theme[upload_mid]="{{ yellow }}"
theme[upload_end]="{{ red }}"

# Process box color gradient for threads, mem and cpu usage
theme[process_start]="{{ cyan }}"
theme[process_mid]="{{ blue }}"
theme[process_end]="{{ magenta }}"

# Graph gradient colors (spectrum shades from background to foreground)
theme[gradient_color_0]="{{ background }}"
theme[gradient_color_1]="{{ lighter_background }}"
theme[gradient_color_2]="{{ selection }}"
theme[gradient_color_3]="{{ muted }}"
theme[gradient_color_4]="{{ dark_foreground }}"
theme[gradient_color_5]="{{ foreground }}"
theme[gradient_color_6]="{{ light_foreground }}"
theme[gradient_color_7]="{{ bright_foreground }}"
