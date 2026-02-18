
import colorgram
import io
from PIL import Image

def extract_brand_colors(image_file, num_colors=5):
    """
    Extracts the two most dominant non-white/non-black colors from an image.
    Returns (primary_hex, secondary_hex).
    """
    try:
        # Load image via Pillow to convert to RGB (stripping alpha if needed)
        image = Image.open(image_file)
        image = image.convert("RGB")
        
        # Resize for speed
        image.thumbnail((200, 200))
        
        # Extract colors
        colors = colorgram.extract(image, num_colors)
        
        valid_colors = []
        for color in colors:
            rgb = color.rgb
            # Filter out near-white and near-black
            if is_distinct_color(rgb):
                valid_colors.append(rgb_to_hex(rgb))
                
        # Fallback defaults
        primary = valid_colors[0] if len(valid_colors) > 0 else "#2D5F6D"
        secondary = valid_colors[1] if len(valid_colors) > 1 else "#EF4835"
        
        # If we only found one color, derive a secondary one (lighter version)
        if len(valid_colors) == 1:
            # Simple lightening/darkening logic could go here, for now use default secondary
             pass

        return primary, secondary
        
    except Exception as e:
        print(f"Error extracting colors: {e}")
        return "#2D5F6D", "#EF4835"

def is_distinct_color(rgb):
    """Returns True if the color is not too close to white or black."""
    r, g, b = rgb
    brightness = (r * 299 + g * 587 + b * 114) / 1000
    
    # Ignore very dark (black) or very bright (white)
    if brightness < 20 or brightness > 245:
        return False
        
    return True

def rgb_to_hex(rgb):
    return '#{:02x}{:02x}{:02x}'.format(rgb.r, rgb.g, rgb.b)
