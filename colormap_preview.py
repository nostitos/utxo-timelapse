import matplotlib.pyplot as plt
import numpy as np

# Create a gradient array
gradient = np.linspace(0, 1, 256).reshape(1, -1)

# Define the colormaps to visualize
colormaps = ['turbo', 'viridis', 'plasma', 'inferno', 'magma', 'cividis']

# Create figure with subplots
fig, axes = plt.subplots(nrows=len(colormaps), figsize=(10, 8))
fig.suptitle('Bitcoin UTXO Visualizer - Colormap Options', fontsize=16, fontweight='bold')

for ax, cmap_name in zip(axes, colormaps):
    # Display the gradient
    ax.imshow(gradient, aspect='auto', cmap=cmap_name)

    # Add label with number
    idx = colormaps.index(cmap_name) + 1
    marker = ' *' if cmap_name == 'turbo' else ''
    ax.set_ylabel(f'{idx}. {cmap_name}{marker}', fontsize=12, fontweight='bold')

    # Remove ticks
    ax.set_xticks([])
    ax.set_yticks([])

    # Add value labels at ends
    ax.text(-15, 0.5, 'Low', ha='right', va='center', fontsize=9)
    ax.text(271, 0.5, 'High', ha='left', va='center', fontsize=9)

plt.tight_layout()
plt.savefig('colormap_comparison.png', dpi=150, bbox_inches='tight')
print("Colormap comparison saved to: colormap_comparison.png")
plt.show()
